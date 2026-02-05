import type {
  ClientConfig,
  OpenClawWakePayload,
  SseEvent,
  WebhookPayload,
} from '@moltx/bridge-types';

interface BridgeClientOptions {
  apiKey: string;
  moltyId: string;
  bridgeUrl?: string;
  openclawUrl?: string;
  openclawToken?: string;
  onWebhook?: (payload: WebhookPayload) => void | Promise<void>;
  onError?: (error: Error) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export class BridgeClient {
  private config: Required<ClientConfig>;
  private eventSource: EventSource | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private reconnectAttempts = 0;
  private isRunning = false;
  private options: BridgeClientOptions;

  constructor(options: BridgeClientOptions) {
    this.options = options;
    this.config = {
      apiKey: options.apiKey,
      moltyId: options.moltyId,
      bridgeUrl: options.bridgeUrl?.replace(/\/$/, '') ?? 'https://bridge.moltx.io',
      openclawUrl: options.openclawUrl?.replace(/\/$/, '') ?? 'http://localhost:18789/hooks',
      openclawToken: options.openclawToken ?? '',
      heartbeatIntervalMs: 30000,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 60000,
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Client is already running');
    }

    this.isRunning = true;
    this.reconnectAttempts = 0;

    console.log(`🦀 Starting Moltx Bridge Client for ${this.config.moltyId}`);
    console.log(`   Bridge: ${this.config.bridgeUrl}`);
    console.log(`   OpenClaw: ${this.config.openclawUrl}`);

    await this.connect();
  }

  stop(): void {
    console.log('🛑 Stopping client...');
    this.isRunning = false;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const url = new URL('/events', this.config.bridgeUrl);

      // EventSource doesn't support headers, so we use query params for auth
      url.searchParams.set('key', this.config.apiKey);
      url.searchParams.set('id', this.config.moltyId);

      this.eventSource = new EventSource(url.toString());

      this.eventSource.onopen = () => {
        console.log('✅ Connected to bridge');
        this.reconnectDelay = this.config.reconnectDelayMs;
        this.reconnectAttempts = 0;
        this.options.onConnected?.();
        this.startHeartbeat();
      };

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleEvent(data);
        } catch (err) {
          console.error('Failed to parse event:', err);
        }
      };

      this.eventSource.onerror = (error) => {
        console.error('❌ EventSource error:', error);
        this.options.onError?.(new Error('EventSource connection failed'));
        this.handleDisconnect();
      };

      // Handle specific event types
      this.eventSource.addEventListener('connected', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('🔗', data.message);
          if (data.expiresAt) {
            console.log('   Expires:', new Date(data.expiresAt).toLocaleString());
          }
        } catch {
          // Ignore parse errors
        }
      });

      this.eventSource.addEventListener('webhook', (event) => {
        try {
          const payload: WebhookPayload = JSON.parse(event.data);
          this.handleWebhook(payload);
        } catch (err) {
          console.error('Failed to handle webhook:', err);
        }
      });

      this.eventSource.addEventListener('warning', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.warn('⚠️ Warning:', data.message);
        } catch {
          // Ignore parse errors
        }
      });

      this.eventSource.addEventListener('ping', () => {
        // Ping received, respond with heartbeat
        this.sendHeartbeat();
      });
    } catch (error) {
      console.error('Failed to connect:', error);
      this.handleDisconnect();
    }
  }

  private handleEvent(data: unknown): void {
    // Generic event handler if needed
  }

  private async handleWebhook(payload: WebhookPayload): Promise<void> {
    console.log(`📨 Webhook received: ${payload.event} (${payload.id})`);

    // Call custom handler if provided
    if (this.options.onWebhook) {
      try {
        await this.options.onWebhook(payload);
        return;
      } catch (err) {
        console.error('Custom webhook handler failed:', err);
      }
    }

    // Default: forward to OpenClaw
    await this.forwardToOpenClaw(payload);
  }

  private async forwardToOpenClaw(payload: WebhookPayload): Promise<void> {
    const hookPayload: OpenClawWakePayload = {
      text: `Webhook from ${payload.source}: ${payload.event}`,
      mode: 'now',
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.openclawToken) {
      headers['Authorization'] = `Bearer ${this.config.openclawToken}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch(`${this.config.openclawUrl}/wake`, {
        method: 'POST',
        headers,
        body: JSON.stringify(hookPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        console.log('✅ Forwarded to OpenClaw');
      } else {
        console.error(`❌ OpenClaw returned ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      console.error('❌ Failed to forward to OpenClaw:', err);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const response = await fetch(`${this.config.bridgeUrl}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: this.config.apiKey,
          moltyId: this.config.moltyId,
        }),
      });

      if (!response.ok) {
        console.warn('Heartbeat failed:', response.status);
      }
    } catch (err) {
      console.warn('Failed to send heartbeat:', err);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  private handleDisconnect(): void {
    this.cleanup();
    this.options.onDisconnected?.();

    if (!this.isRunning) return;

    // Exponential backoff
    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    console.log(
      `🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`
    );

    setTimeout(() => {
      if (this.isRunning) {
        this.connect();
      }
    }, delay);
  }
}

// Factory function for easier usage
export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  return new BridgeClient(options);
}
