import { createHash, randomBytes } from 'node:crypto';
import type { MoltyRecord, RegisterResponse } from '@moltx/bridge-types';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Initialize schema
export async function initDatabase(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS moltys (
      id TEXT PRIMARY KEY,
      molty_id TEXT UNIQUE NOT NULL,
      api_key_hash TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      last_connected_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT TRUE,
      connection_count INTEGER DEFAULT 0
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      molty_id TEXT NOT NULL REFERENCES moltys(molty_id),
      status TEXT NOT NULL DEFAULT 'active',
      current_period_start TIMESTAMPTZ NOT NULL,
      current_period_end TIMESTAMPTZ NOT NULL,
      cancel_at_period_end BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(molty_id)
    );
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_moltys_molty_id ON moltys(molty_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_moltys_api_key_hash ON moltys(api_key_hash);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_moltys_is_active ON moltys(is_active);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_molty_id ON subscriptions(molty_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON subscriptions(current_period_end);`;
}

// Initialize on module load
await initDatabase();

// Helper functions
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export function generateApiKey(): string {
  return `molty_${randomBytes(32).toString('base64url')}`;
}

export async function registerOrRenewMolty(
  moltyId: string,
  walletAddress: string,
  isRenewal: boolean
): Promise<
  RegisterResponse & { apiKey: string; subscription: { periodStart: string; periodEnd: string } }
> {
  const now = new Date();
  const periodStart = now;
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const moltyIdBytes = randomBytes(16).toString('hex');
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const subId = randomBytes(16).toString('hex');

  // Use transaction to ensure both operations succeed or fail together
  const result = await sql.begin(async (trx) => {
    // Insert/update molty using upsert
    await trx.unsafe(`
      INSERT INTO moltys (id, molty_id, api_key_hash, wallet_address, created_at, updated_at, is_active)
      VALUES ('${moltyIdBytes}', '${moltyId}', '${apiKeyHash}', '${walletAddress}', '${now.toISOString()}', '${now.toISOString()}', TRUE)
      ON CONFLICT(molty_id) DO UPDATE SET
        api_key_hash = EXCLUDED.api_key_hash,
        wallet_address = EXCLUDED.wallet_address,
        updated_at = EXCLUDED.updated_at,
        is_active = TRUE
    `);

    // Insert/update subscription using upsert
    await trx.unsafe(`
      INSERT INTO subscriptions (id, molty_id, status, current_period_start, current_period_end, created_at, updated_at, cancel_at_period_end)
      VALUES ('${subId}', '${moltyId}', 'active', '${periodStart.toISOString()}', '${periodEnd.toISOString()}', '${now.toISOString()}', '${now.toISOString()}', FALSE)
      ON CONFLICT(molty_id) DO UPDATE SET
        status = EXCLUDED.status,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = FALSE,
        updated_at = EXCLUDED.updated_at
    `);

    return {
      apiKey,
      expiresAt: periodEnd.toISOString(),
      webhookUrl: `${process.env.PUBLIC_URL ?? 'https://bridge.moltx.io'}/webhooks/${encodeURIComponent(moltyId)}`,
      subscription: {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      },
    };
  });

  return result;
}

export async function getMolty(moltyId: string): Promise<MoltyRecord | null> {
  const result = await sql<MoltyRecord[]>`SELECT * FROM moltys WHERE molty_id = ${moltyId}`;
  return result[0] ?? null;
}

export async function validateApiKey(apiKey: string): Promise<MoltyRecord | null> {
  const hash = hashApiKey(apiKey);
  const result = await sql<MoltyRecord[]>`SELECT * FROM moltys WHERE api_key_hash = ${hash}`;
  return result[0] ?? null;
}

export async function recordConnection(moltyId: string): Promise<void> {
  await sql`
    UPDATE moltys 
    SET last_connected_at = ${new Date().toISOString()}, 
        connection_count = connection_count + 1 
    WHERE molty_id = ${moltyId}
  `;
}

export async function recordHeartbeat(moltyId: string): Promise<void> {
  await sql`
    UPDATE moltys 
    SET last_heartbeat_at = ${new Date().toISOString()} 
    WHERE molty_id = ${moltyId}
  `;
}

export async function deactivate(moltyId: string): Promise<void> {
  await sql`UPDATE moltys SET is_active = FALSE WHERE molty_id = ${moltyId}`;
}

export async function cleanup(): Promise<number> {
  // Note: The original SQLite code referenced an 'expires_at' column which doesn't exist in the schema
  // Using a reasonable cleanup logic based on last_connected_at
  const result = await sql`
    DELETE FROM moltys 
    WHERE is_active = FALSE 
    AND last_connected_at < NOW() - INTERVAL '7 days'
  `;
  return result.count;
}

// Get moltys expiring within days
export async function getExpiringMoltys(days: number): Promise<MoltyRecord[]> {
  const result = await sql<MoltyRecord[]>`
    SELECT m.* FROM moltys m
    JOIN subscriptions s ON m.molty_id = s.molty_id
    WHERE m.is_active = TRUE 
    AND s.current_period_end BETWEEN NOW() AND NOW() + ${sql`${days} days`}
  `;
  return result;
}

// Get subscription for a molty
export async function getSubscription(
  moltyId: string
): Promise<{ status: string; current_period_end: string; cancel_at_period_end: boolean } | null> {
  const result = await sql<
    { status: string; current_period_end: string; cancel_at_period_end: boolean }[]
  >`
    SELECT status, current_period_end, cancel_at_period_end
    FROM subscriptions
    WHERE molty_id = ${moltyId}
  `;
  if (!result[0]) return null;
  return {
    status: result[0].status,
    current_period_end: result[0].current_period_end,
    cancel_at_period_end: result[0].cancel_at_period_end,
  };
}

// Check if subscription is expired
export async function isSubscriptionActive(moltyId: string): Promise<boolean> {
  const sub = await getSubscription(moltyId);
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  return new Date(sub.current_period_end) > new Date();
}

// Get moltys with subscriptions expiring within days
export async function getExpiringSubscriptions(
  days: number
): Promise<Array<{ moltyId: string; periodEnd: string; cancelAtPeriodEnd: boolean }>> {
  const results = await sql<
    { molty_id: string; current_period_end: string; cancel_at_period_end: boolean }[]
  >`
    SELECT m.molty_id, s.current_period_end, s.cancel_at_period_end
    FROM subscriptions s
    JOIN moltys m ON s.molty_id = m.molty_id
    WHERE s.status = 'active'
    AND s.current_period_end BETWEEN NOW() AND NOW() + ${sql`${days} days`}
  `;
  return results.map(
    (r: { molty_id: string; current_period_end: string; cancel_at_period_end: boolean }) => ({
      moltyId: r.molty_id,
      periodEnd: r.current_period_end,
      cancelAtPeriodEnd: !!r.cancel_at_period_end,
    })
  );
}

// Mark expired subscriptions
export async function markExpiredSubscriptions(): Promise<number> {
  const result = await sql`
    UPDATE subscriptions
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active' AND current_period_end < NOW()
  `;
  return result.count;
}

// Cancel subscription (at period end)
export async function cancelSubscription(moltyId: string): Promise<boolean> {
  const result = await sql`
    UPDATE subscriptions
    SET cancel_at_period_end = TRUE, updated_at = NOW()
    WHERE molty_id = ${moltyId}
  `;
  return result.count > 0;
}

// Legacy compatibility
export async function isExpired(molty: MoltyRecord): Promise<boolean> {
  return !(await isSubscriptionActive(molty.moltyId));
}

// Export database instance for admin queries
export function getDatabase(): typeof sql {
  return sql;
}
