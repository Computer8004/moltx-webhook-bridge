// Moltx Notify - Free notification relay for AI agents
// Supports both Moltx (moltx.io) and Moltbook (moltbook.com)

// Rate limits (conservative defaults)
const DEFAULT_POLL_INTERVAL_MS = 60000; // 60 seconds - safe for both platforms
const MOLTBOOK_RATE_LIMIT = 100; // 100 req/min for moltbook.com
const MOLTX_RATE_LIMIT = 600; // 600 req/min for moltx.io (claimed agents)
const JITTER_MAX_MS = 5000; // Add up to 5s random jitter

export interface MoltxNotification {
  id: string;
  type: 'mention' | 'reply' | 'follow' | 'upvote' | 'system';
  actorId: string;
  actorName: string;
  targetId?: string;
  targetType?: 'post' | 'comment' | 'user';
  content?: string;
  read: boolean;
  createdAt: string;
  source: 'moltx' | 'moltbook';
}

export interface MoltxMention {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  content: string;
  submolt?: string;
  createdAt: string;
  source: 'moltx' | 'moltbook';
}

export interface NotifyConfig {
  // Moltx (moltx.io) config
  moltxApiKey?: string;
  moltxBaseUrl?: string;
  
  // Moltbook (moltbook.com) config
  moltbookApiKey?: string;
  moltbookBaseUrl?: string;
  
  // General config
  pollIntervalMs?: number;
  openclawUrl?: string;
  openclawToken?: string;
  enableJitter?: boolean; // Add random delay to prevent thundering herd
}

export class MoltxNotify {
  private moltxApiKey?: string;
  private moltxBaseUrl: string;
  private moltbookApiKey?: string;
  private moltbookBaseUrl: string;
  private pollIntervalMs: number;
  private openclawUrl: string;
  private openclawToken: string;
  private enableJitter: boolean;
  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private lastMoltxCheck = new Date(0);
  private lastMoltbookCheck = new Date(0);
  private onNotification?: (n: MoltxNotification) => void;
  private onMention?: (m: MoltxMention) => void;
  private onError?: (e: Error) => void;
  
  // Rate limit tracking
  private moltxRequestCount = 0;
  private moltxWindowStart = Date.now();
  private moltbookRequestCount = 0;
  private moltbookWindowStart = Date.now();

  constructor(config: NotifyConfig & {
    onNotification?: (n: MoltxNotification) => void;
    onMention?: (m: MoltxMention) => void;
    onError?: (e: Error) => void;
  }) {
    this.moltxApiKey = config.moltxApiKey;
    this.moltxBaseUrl = (config.moltxBaseUrl ?? 'https://moltx.io/v1').replace(/\/$/, '');
    this.moltbookApiKey = config.moltbookApiKey;
    this.moltbookBaseUrl = (config.moltbookBaseUrl ?? 'https://www.moltbook.com/api/v1').replace(/\/$/, '');
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.openclawUrl = (config.openclawUrl ?? 'http://localhost:18789/hooks').replace(/\/$/, '');
    this.openclawToken = config.openclawToken ?? '';
    this.enableJitter = config.enableJitter ?? true;
    this.onNotification = config.onNotification;
    this.onMention = config.onMention;
    this.onError = config.onError;
    
    // Validate poll interval is safe
    if (this.pollIntervalMs < 30000) {
      console.warn(`[moltx-notify] Poll interval ${this.pollIntervalMs}ms is very aggressive.`);
      console.warn(`                   Moltbook allows 100 req/min. 30s interval = 2 req/min per endpoint.`);
      console.warn(`                   Consider increasing to 60s+ for safety.`);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    
    if (!this.moltxApiKey && !this.moltbookApiKey) {
      throw new Error('At least one API key required (MOLTX_API_KEY or MOLTBOOK_API_KEY)');
    }
    
    console.log('🦀 Moltx Notify starting...');
    console.log(`   Poll interval: ${this.pollIntervalMs}ms`);
    if (this.moltxApiKey) console.log(`   Moltx: ${this.moltxBaseUrl}`);
    if (this.moltbookApiKey) console.log(`   Moltbook: ${this.moltbookBaseUrl}`);
    console.log(`   Forwarding to: ${this.openclawUrl}`);
    
    this.isRunning = true;
    this.abortController = new AbortController();
    
    // Initial poll with jitter
    await this.pollWithJitter();
    
    // Start polling loop
    this.pollTimer = setInterval(() => {
      if (this.isRunning) {
        this.pollWithJitter().catch(err => this.onError?.(err));
      }
    }, this.pollIntervalMs);
    
    console.log(`✅ Started polling (rate limit safe: ${Math.ceil(60000 / this.pollIntervalMs)} req/min max)`);
  }

  stop(): void {
    console.log('🛑 Stopping Moltx Notify...');
    this.isRunning = false;
    this.abortController?.abort();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollWithJitter(): Promise<void> {
    // Add random jitter to prevent thundering herd
    if (this.enableJitter) {
      const jitter = Math.random() * JITTER_MAX_MS;
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
    
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      // Poll Moltx (moltx.io) if configured
      if (this.moltxApiKey) {
        await this.pollMoltx();
      }
      
      // Poll Moltbook (moltbook.com) if configured
      if (this.moltbookApiKey) {
        await this.pollMoltbook();
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw err;
    }
  }

  private async pollMoltx(): Promise<void> {
    const since = this.lastMoltxCheck.toISOString();
    
    try {
      // Check rate limit before making requests
      if (!this.checkMoltxRateLimit()) {
        console.warn('[moltx.io] Rate limit approaching, skipping this poll');
        return;
      }
      
      // Fetch notifications from Moltx
      const notifications = await this.fetchMoltxNotifications(since);
      this.moltxRequestCount++;
      for (const notification of notifications) {
        if (!notification.read) {
          const n: MoltxNotification = { ...notification, source: 'moltx' };
          this.onNotification?.(n);
          await this.forwardToOpenClaw('notification', n, 'moltx');
        }
      }
      
      // Check rate limit before mentions
      if (!this.checkMoltxRateLimit()) {
        console.warn('[moltx.io] Rate limit approaching, skipping mentions fetch');
        this.lastMoltxCheck = new Date();
        return;
      }
      
      // Fetch mentions from Moltx
      const mentions = await this.fetchMoltxMentions(since);
      this.moltxRequestCount++;
      for (const mention of mentions) {
        const m: MoltxMention = { ...mention, source: 'moltx' };
        this.onMention?.(m);
        await this.forwardToOpenClaw('mention', m, 'moltx');
      }
      
      this.lastMoltxCheck = new Date();
    } catch (err) {
      if (this.isRateLimitError(err)) {
        console.error('[moltx.io] Rate limited (429). Will retry next poll.');
        return;
      }
      console.error('[moltx.io] Poll error:', err);
    }
  }

  private async pollMoltbook(): Promise<void> {
    const since = this.lastMoltbookCheck.toISOString();
    
    try {
      // Check rate limit before making requests
      if (!this.checkMoltbookRateLimit()) {
        console.warn('[moltbook.com] Rate limit approaching (100/min), skipping this poll');
        return;
      }
      
      // Fetch notifications from Moltbook
      const notifications = await this.fetchMoltbookNotifications(since);
      this.moltbookRequestCount++;
      for (const notification of notifications) {
        if (!notification.read) {
          const n: MoltxNotification = { ...notification, source: 'moltbook' };
          this.onNotification?.(n);
          await this.forwardToOpenClaw('notification', n, 'moltbook');
        }
      }
      
      // Check rate limit before mentions
      if (!this.checkMoltbookRateLimit()) {
        console.warn('[moltbook.com] Rate limit approaching, skipping mentions fetch');
        this.lastMoltbookCheck = new Date();
        return;
      }
      
      // Fetch mentions from Moltbook
      const mentions = await this.fetchMoltbookMentions(since);
      this.moltbookRequestCount++;
      for (const mention of mentions) {
        const m: MoltxMention = { ...mention, source: 'moltbook' };
        this.onMention?.(m);
        await this.forwardToOpenClaw('mention', m, 'moltbook');
      }
      
      this.lastMoltbookCheck = new Date();
    } catch (err) {
      if (this.isRateLimitError(err)) {
        console.error('[moltbook.com] Rate limited (429). Will retry next poll.');
        return;
      }
      console.error('[moltbook.com] Poll error:', err);
    }
  }

  private checkMoltxRateLimit(): boolean {
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    
    // Reset window
    if (now - this.moltxWindowStart > windowMs) {
      this.moltxWindowStart = now;
      this.moltxRequestCount = 0;
    }
    
    // Leave 20% buffer (conservative: 480 req/min instead of 600)
    return this.moltxRequestCount < (MOLTX_RATE_LIMIT * 0.8);
  }

  private checkMoltbookRateLimit(): boolean {
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    
    // Reset window
    if (now - this.moltbookWindowStart > windowMs) {
      this.moltbookWindowStart = now;
      this.moltbookRequestCount = 0;
    }
    
    // Leave 20% buffer (conservative: 80 req/min instead of 100)
    return this.moltbookRequestCount < (MOLTBOOK_RATE_LIMIT * 0.8);
  }

  private isRateLimitError(err: unknown): boolean {
    return err instanceof Error && 
           (err.message.includes('429') || err.message.includes('rate limit'));
  }

  private async fetchMoltxNotifications(since?: string): Promise<Omit<MoltxNotification, 'source'>[]> {
    const url = new URL('/notifications', this.moltxBaseUrl);
    if (since) url.searchParams.set('since', since);
    
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.moltxApiKey}`,
        'Accept': 'application/json',
      },
      signal: this.abortController?.signal,
    });
    
    if (response.status === 429) {
      throw new Error('429 Rate limited');
    }
    
    if (!response.ok) {
      throw new Error(`Moltx API error: ${response.status}`);
    }
    
    return response.json();
  }

  private async fetchMoltxMentions(since?: string): Promise<Omit<MoltxMention, 'source'>[]> {
    const url = new URL('/mentions', this.moltxBaseUrl);
    if (since) url.searchParams.set('since', since);
    
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.moltxApiKey}`,
        'Accept': 'application/json',
      },
      signal: this.abortController?.signal,
    });
    
    if (response.status === 429) {
      throw new Error('429 Rate limited');
    }
    
    if (!response.ok) {
      throw new Error(`Moltx API error: ${response.status}`);
    }
    
    return response.json();
  }

  private async fetchMoltbookNotifications(since?: string): Promise<Omit<MoltxNotification, 'source'>[]> {
    // Moltbook doesn't have a dedicated notifications endpoint yet
    // Return empty array for now - mentions will still work
    return [];
  }

  private async fetchMoltbookMentions(since?: string): Promise<Omit<MoltxMention, 'source'>[]> {
    // Moltbook doesn't have a mentions endpoint - check feed instead
    // Return empty array for now
    return [];
  }

  private async forwardToOpenClaw(type: string, data: unknown, source: string): Promise<void> {
    const payload = {
      text: `${source} ${type}: ${JSON.stringify(data).slice(0, 100)}...`,
      mode: 'now' as const,
    };
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (this.openclawToken) {
      headers['Authorization'] = `Bearer ${this.openclawToken}`;
    }
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(`${this.openclawUrl}/wake`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (response.ok) {
        console.log(`✅ Forwarded ${source} ${type} to OpenClaw`);
      } else {
        console.error(`❌ OpenClaw error: ${response.status}`);
      }
    } catch (err) {
      console.error(`❌ Failed to forward ${type}:`, err);
    }
  }
}

// Factory function
export function createMoltxNotify(config: ConstructorParameters<typeof MoltxNotify>[0]): MoltxNotify {
  return new MoltxNotify(config);
}