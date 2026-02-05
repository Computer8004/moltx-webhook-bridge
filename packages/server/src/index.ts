import { cors } from '@elysiajs/cors';
import type { MoltxMention, MoltxNotification, WebhookPayload } from '@moltx/bridge-types';
import { Elysia } from 'elysia';
import { rateLimit } from 'elysia-rate-limit';
import { z } from 'zod';
import * as connections from './connections/manager.js';
import * as db from './db/index.js';
import { createMoltxClient } from './moltx/client.js';
import { getPaymentRequirements, verifyX402Payment } from './payments/x402.js';

const MOLTX_API_KEY = process.env.MOLTX_API_KEY;
const PORT = Number.parseInt(process.env.PORT ?? '8080');

// Standardized error response helper
function errorResponse(
  message: string,
  status: number,
  details?: unknown
): { success: false; error: string; details?: unknown; timestamp: string } {
  return {
    success: false,
    error: message,
    ...(details !== undefined && { details }),
    timestamp: new Date().toISOString(),
  };
}

// Constants for magic numbers
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Hourly
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily

// Validation schemas
const MOLTY_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

const registerSchema = z.object({
  moltyId: z
    .string()
    .min(1)
    .max(256)
    .regex(
      MOLTY_ID_REGEX,
      'moltyId must contain only alphanumeric characters, hyphens, and underscores'
    ),
  x402Payment: z.object({
    schemaId: z.string(),
    network: z.string(),
    payload: z.object({
      signature: z.string(),
      timestamp: z.number(),
      address: z.string(),
    }),
  }),
  isRenewal: z.boolean().optional(),
});

const webhookSchema = z.object({
  event: z.string(),
  data: z.unknown(),
});

// Create app
const app = new Elysia()
  .use(cors())
  .use(
    rateLimit({
      max: 100, // 100 requests
      duration: 60000, // per minute
    })
  )

  // Get payment requirements (for clients to know what to pay)
  .get('/payment-requirements', () => getPaymentRequirements())

  // Register or renew a molty subscription
  .post('/register', async ({ body, set }) => {
    const parseResult = registerSchema.safeParse(body);

    if (!parseResult.success) {
      set.status = 400;
      return errorResponse('Invalid request', 400, parseResult.error.errors);
    }

    const { moltyId, x402Payment, isRenewal } = parseResult.data;

    // Verify payment
    const paymentResult = await verifyX402Payment(x402Payment);

    if (!paymentResult.valid) {
      set.status = 402;
      return errorResponse('Payment verification failed', 402, {
        details: paymentResult.error,
        requirements: getPaymentRequirements(),
      });
    }

    // Check if this is a renewal
    const existingMolty = await db.getMolty(moltyId);
    const isActuallyRenewal = isRenewal || !!existingMolty;

    // Register or renew
    const result = await db.registerOrRenewMolty(
      moltyId,
      paymentResult.walletAddress!,
      isActuallyRenewal
    );

    return {
      success: true,
      action: isActuallyRenewal ? 'renewal' : 'new',
      apiKey: result.apiKey,
      expiresAt: result.expiresAt,
      webhookUrl: result.webhookUrl,
      subscription: result.subscription,
    };
  })

  // Get subscription status
  .get('/subscription/:moltyId', async ({ params, request, set }) => {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      set.status = 401;
      return errorResponse('Missing authorization', 401);
    }

    const apiKey = authHeader.slice(7);
    const molty = await db.validateApiKey(apiKey);
    const moltyId = decodeURIComponent(params.moltyId);

    if (!molty || molty.moltyId !== moltyId) {
      set.status = 401;
      return errorResponse('Invalid API key', 401);
    }

    const sub = await db.getSubscription(moltyId);
    if (!sub) {
      set.status = 404;
      return errorResponse('No subscription found', 404);
    }

    return {
      moltyId,
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      isActive: await db.isSubscriptionActive(moltyId),
    };
  })

  // SSE endpoint for molty clients
  .get('/events', async ({ request, query, set }) => {
    // Support both headers (programmatic) and query params (EventSource)
    const authHeader = request.headers.get('authorization');
    const headerMoltyId = request.headers.get('x-molty-id');

    const queryApiKey = query.key as string | undefined;
    const queryMoltyId = query.id as string | undefined;

    const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : queryApiKey;

    const moltyId = headerMoltyId ?? queryMoltyId;

    if (!apiKey) {
      set.status = 401;
      return errorResponse('Missing API key. Use Authorization header or ?key= query param.', 401);
    }

    if (!moltyId) {
      set.status = 400;
      return errorResponse('Missing molty ID. Use X-Molty-Id header or ?id= query param.', 400);
    }

    const molty = await db.validateApiKey(apiKey);

    if (!molty || molty.moltyId !== moltyId) {
      set.status = 401;
      return errorResponse('Invalid API key', 401);
    }

    // Check subscription status
    const sub = await db.getSubscription(moltyId);
    if (!sub || sub.status !== 'active' || new Date(sub.current_period_end) <= new Date()) {
      set.status = 403;
      return errorResponse('Subscription expired. Please renew at $0.01/month.', 403);
    }

    // Record connection in DB
    await db.recordConnection(moltyId);

    // Create SSE stream
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Add connection to manager
        connections.addConnection(moltyId, controller);

        // Send initial connected event
        const message = connections.formatSseMessage('connected', {
          moltyId,
          subscription: {
            periodEnd: sub.current_period_end,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          },
          message: 'Connected to webhook bridge',
        });
        controller.enqueue(encoder.encode(message));

        // Check for expiration warning (2 weeks before)
        const periodEnd = new Date(sub.current_period_end);
        const twoWeeks = 14 * 24 * 60 * 60 * 1000;
        if (periodEnd.getTime() - Date.now() < twoWeeks) {
          const warning = connections.formatSseMessage('warning', {
            type: 'subscription_expiring',
            message: `Your subscription ends on ${periodEnd.toISOString()}. Renew with $0.01 to avoid interruption.`,
            periodEnd: sub.current_period_end,
            renewUrl: `${process.env.PUBLIC_URL ?? 'https://bridge.moltx.io'}/register`,
          });
          controller.enqueue(encoder.encode(warning));
        }

        // Handle client disconnect
        request.signal.addEventListener('abort', () => {
          connections.removeConnection(moltyId);
        });
      },
      cancel() {
        connections.removeConnection(moltyId);
      },
    });

    set.headers['Content-Type'] = 'text/event-stream';
    set.headers['Cache-Control'] = 'no-cache';
    set.headers['Connection'] = 'keep-alive';
    set.headers['Retry-After'] = '30'; // SSE retry after 30 seconds on disconnect

    return stream;
  })

  // Webhook ingest from Moltx/Moltbook
  .post('/webhooks/:moltyId', async ({ params, body, request, set }) => {
    // Verify Moltx auth
    const authHeader = request.headers.get('authorization');
    if (!MOLTX_API_KEY || authHeader !== `Bearer ${MOLTX_API_KEY}`) {
      set.status = 401;
      return errorResponse('Unauthorized', 401);
    }

    const moltyId = decodeURIComponent(params.moltyId);

    // Check if molty exists
    const molty = await db.getMolty(moltyId);
    if (!molty) {
      set.status = 404;
      return errorResponse('Molty not found', 404);
    }

    if (!molty.isActive) {
      set.status = 403;
      return errorResponse('Molty is not active', 403);
    }

    // Check if molty is connected
    if (!connections.hasConnection(moltyId)) {
      set.status = 503;
      set.headers['Retry-After'] = '30';
      return errorResponse('Molty is not connected', 503, { retryAfter: 30 });
    }

    // Parse and validate webhook payload
    const parseResult = webhookSchema.safeParse(body);
    if (!parseResult.success) {
      set.status = 400;
      return errorResponse('Invalid webhook payload', 400, parseResult.error.errors);
    }

    const payload: WebhookPayload = {
      id: crypto.randomUUID(),
      source: 'moltx',
      event: parseResult.data.event,
      timestamp: new Date().toISOString(),
      data: parseResult.data.data,
    };

    // Send to connected client
    const sent = connections.sendEvent(moltyId, 'webhook', payload);

    if (!sent) {
      set.status = 503;
      return errorResponse('Failed to deliver webhook', 503);
    }

    set.status = 202;
    return {
      success: true,
      message: 'Webhook queued for delivery',
      webhookId: payload.id,
    };
  })

  // Client heartbeat response endpoint
  .post('/heartbeat', async ({ request, body, set }) => {
    // Support both headers and JSON body
    const authHeader = request.headers.get('authorization');
    const headerMoltyId = request.headers.get('x-molty-id');

    const bodyApiKey = (body as { apiKey?: string })?.apiKey;
    const bodyMoltyId = (body as { moltyId?: string })?.moltyId;

    const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : bodyApiKey;

    const moltyId = headerMoltyId ?? bodyMoltyId;

    if (!apiKey) {
      set.status = 401;
      return errorResponse('Missing API key. Use Authorization header or include in body.', 401);
    }

    if (!moltyId) {
      set.status = 400;
      return errorResponse('Missing molty ID. Use X-Molty-Id header or include in body.', 400);
    }
    const molty = await db.validateApiKey(apiKey);

    if (!molty || molty.moltyId !== moltyId) {
      set.status = 401;
      return errorResponse('Invalid API key', 401);
    }

    // Update heartbeat in connection manager
    const updated = connections.updateHeartbeat(moltyId);

    if (updated) {
      // Also update in DB
      await db.recordHeartbeat(moltyId);
    }

    const sub = await db.getSubscription(moltyId);

    return {
      success: true,
      timestamp: new Date().toISOString(),
      subscription: sub
        ? {
            status: sub.status,
            periodEnd: sub.current_period_end,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          }
        : null,
    };
  })

  // Admin: Get stats
  .get('/admin/stats', async ({ request, set }) => {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${MOLTX_API_KEY}`) {
      set.status = 401;
      return errorResponse('Unauthorized', 401);
    }

    // Query database for subscription stats using raw SQL
    const subStatsResult = await db.getDatabase()`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'active' AND current_period_end > NOW() THEN 1 END) as active,
        COUNT(CASE WHEN status = 'expired' OR (status = 'active' AND current_period_end <= NOW()) THEN 1 END) as expired
      FROM subscriptions
    `;
    const subStats = subStatsResult[0] as { total: number; active: number; expired: number };

    const moltyStatsResult = await db.getDatabase()`
      SELECT COUNT(*) as total FROM moltys
    `;
    const moltyStats = moltyStatsResult[0] as { total: number };

    return {
      connections: connections.getStats(),
      subscriptions: {
        total: subStats?.total ?? 0,
        active: subStats?.active ?? 0,
        expired: subStats?.expired ?? 0,
      },
      moltys: {
        total: moltyStats?.total ?? 0,
      },
    };
  })

  // 404 handler
  .onError(({ code, set }) => {
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return errorResponse('Not found', 404);
    }
  });

// Start heartbeat checker
setInterval(() => {
  const stale = connections.checkHeartbeats();
  if (stale.length > 0) {
    console.log(`[heartbeat] Removed ${stale.length} stale connections`);
  }
}, 30000);

// Start cleanup job
setInterval(
  async () => {
    try {
      // Clean up stale molty registrations
      const deleted = await db.cleanup();
      if (deleted > 0) {
        console.log(`[cleanup] Removed ${deleted} stale molty registrations`);
      }

      // Mark expired subscriptions
      const expired = await db.markExpiredSubscriptions();
      if (expired > 0) {
        console.log(`[cleanup] Marked ${expired} subscriptions as expired`);
      }
    } catch (err) {
      console.error('[cleanup] Error during cleanup job:', err);
    }
  },
  60 * 60 * 1000
); // Hourly

// Send renewal reminders (daily at noon UTC)
setInterval(
  async () => {
    try {
      const expiring = await db.getExpiringSubscriptions(14); // 2 weeks out
      for (const sub of expiring) {
        // Send warning via SSE if connected
        if (connections.hasConnection(sub.moltyId)) {
          connections.sendEvent(sub.moltyId, 'warning', {
            type: 'subscription_expiring',
            message: `Your subscription ends on ${sub.periodEnd}. Renew with $0.01 to avoid interruption.`,
            periodEnd: sub.periodEnd,
            daysRemaining: Math.ceil(
              (new Date(sub.periodEnd).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
            ),
            renewUrl: `${process.env.PUBLIC_URL ?? 'https://bridge.moltx.io'}/register`,
          });
        }
      }

      if (expiring.length > 0) {
        console.log(`[reminders] Sent ${expiring.length} renewal reminders`);
      }
    } catch (err) {
      console.error('[reminders] Error during reminder job:', err);
    }
  },
  24 * 60 * 60 * 1000
); // Daily

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, closing connections...');
  moltxClient?.stop();
  connections.closeAll();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[server] SIGINT received, closing connections...');
  moltxClient?.stop();
  connections.closeAll();
  process.exit(0);
});

// Initialize Moltx client for polling (if API key is configured)
const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY;
let moltxClient: ReturnType<typeof createMoltxClient> | null = null;

if (MOLTBOOK_API_KEY) {
  moltxClient = createMoltxClient({
    apiKey: MOLTBOOK_API_KEY,
    onNotification: async (notification: MoltxNotification) => {
      // Forward to all connected moltys (or specific ones based on notification)
      console.log(`[moltx] Notification: ${notification.type} from ${notification.actorName}`);
      
      // For now, broadcast to all connected clients
      // In production, you might want to route based on moltyId
      const stats = connections.getStats();
      for (const moltyId of stats.moltyIds) {
        const payload: WebhookPayload = {
          id: crypto.randomUUID(),
          source: 'moltx',
          event: `notification.${notification.type}`,
          timestamp: new Date().toISOString(),
          data: notification,
        };
        connections.sendEvent(moltyId, 'webhook', payload);
      }
    },
    onMention: async (mention: MoltxMention) => {
      console.log(`[moltx] Mention from ${mention.authorName}`);
      
      // Forward to all connected moltys
      const stats = connections.getStats();
      for (const moltyId of stats.moltyIds) {
        const payload: WebhookPayload = {
          id: crypto.randomUUID(),
          source: 'moltx',
          event: 'mention.received',
          timestamp: new Date().toISOString(),
          data: mention,
        };
        connections.sendEvent(moltyId, 'webhook', payload);
      }
    },
    onError: (err: Error) => {
      console.error('[moltx] Client error:', err.message);
    },
  });

  // Start polling
  moltxClient.start(30000).catch((err) => {
    console.error('[moltx] Failed to start client:', err);
  });
} else {
  console.log('[moltx] MOLTBOOK_API_KEY not set - Moltx polling disabled');
  console.log('        Set MOLTBOOK_API_KEY to enable automatic webhook delivery from Moltx');
}

// Start server
app.listen(PORT);

console.log(`🦀 Moltx Webhook Bridge Server running on port ${PORT}`);
console.log(`   Health check: http://localhost:${PORT}/health`);
console.log(`   Moltx polling: ${MOLTBOOK_API_KEY ? 'enabled' : 'disabled'}`);
