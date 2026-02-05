// Moltx Notify - Free notification relay for AI agents
// Supports both Moltx (moltx.io) and Moltbook (moltbook.com)

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
}

export class MoltxNotify {
  private moltxApiKey?: string;
  private moltxBaseUrl: string;
  private moltbookApiKey?: string;
  private moltbookBaseUrl: string;
  private pollIntervalMs: number;
  private openclawUrl: string;
  private openclawToken: string;
  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private lastMoltxCheck = new Date(0);
  private lastMoltbookCheck = new Date(0);
  private onNotification?: (n: MoltxNotification) => void;
  private onMention?: (m: MoltxMention) => void;
  private onError?: (e: Error) => void;

  constructor(config: NotifyConfig & {
    onNotification?: (n: MoltxNotification) => void;
    onMention?: (m: MoltxMention) => void;
    onError?: (e: Error) => void;
  }) {
    this.moltxApiKey = config.moltxApiKey;
    this.moltxBaseUrl = (config.moltxBaseUrl ?? 'https://moltx.io/api').replace(/\/$/, '');
    this.moltbookApiKey = config.moltbookApiKey;
    this.moltbookBaseUrl = (config.moltbookBaseUrl ?? 'https://www.moltbook.com/api/v1').replace(/\/$/, '');
    this.pollIntervalMs = config.pollIntervalMs ?? 30000;
    this.openclawUrl = (config.openclawUrl ?? 'http://localhost:18789/hooks').replace(/\/$/, '');
    this.openclawToken = config.openclawToken ?? '';
    this.onNotification = config.onNotification;
    this.onMention = config.onMention;
    this.onError = config.onError;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    
    if (!this.moltxApiKey && !this.moltbookApiKey) {
      throw new Error('At least one API key required (MOLTX_API_KEY or MOLTBOOK_API_KEY)');
    }
    
    console.log('🦀 Moltx Notify starting...');
    if (this.moltxApiKey) console.log(`   Moltx: ${this.moltxBaseUrl}`);
    if (this.moltbookApiKey) console.log(`   Moltbook: ${this.moltbookBaseUrl}`);
    console.log(`   Forwarding to: ${this.openclawUrl}`);
    
    this.isRunning = true;
    this.abortController = new AbortController();
    
    // Initial poll
    await this.poll();
    
    // Start polling loop
    this.pollTimer = setInterval(() => {
      if (this.isRunning) {
        this.poll().catch(err => this.onError?.(err));
      }
    }, this.pollIntervalMs);
    
    console.log(`✅ Started polling every ${this.pollIntervalMs}ms`);
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
      // Fetch notifications from Moltx
      const notifications = await this.fetchMoltxNotifications(since);
      for (const notification of notifications) {
        if (!notification.read) {
          const n: MoltxNotification = { ...notification, source: 'moltx' };
          this.onNotification?.(n);
          await this.forwardToOpenClaw('notification', n, 'moltx');
        }
      }
      
      // Fetch mentions from Moltx
      const mentions = await this.fetchMoltxMentions(since);
      for (const mention of mentions) {
        const m: MoltxMention = { ...mention, source: 'moltx' };
        this.onMention?.(m);
        await this.forwardToOpenClaw('mention', m, 'moltx');
      }
      
      this.lastMoltxCheck = new Date();
    } catch (err) {
      console.error('[moltx.io] Poll error:', err);
    }
  }

  private async pollMoltbook(): Promise<void> {
    const since = this.lastMoltbookCheck.toISOString();
    
    try {
      // Fetch notifications from Moltbook
      const notifications = await this.fetchMoltbookNotifications(since);
      for (const notification of notifications) {
        if (!notification.read) {
          const n: MoltxNotification = { ...notification, source: 'moltbook' };
          this.onNotification?.(n);
          await this.forwardToOpenClaw('notification', n, 'moltbook');
        }
      }
      
      // Fetch mentions from Moltbook
      const mentions = await this.fetchMoltbookMentions(since);
      for (const mention of mentions) {
        const m: MoltxMention = { ...mention, source: 'moltbook' };
        this.onMention?.(m);
        await this.forwardToOpenClaw('mention', m, 'moltbook');
      }
      
      this.lastMoltbookCheck = new Date();
    } catch (err) {
      console.error('[moltbook.com] Poll error:', err);
    }
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
    
    if (!response.ok) {
      throw new Error(`Moltx API error: ${response.status}`);
    }
    
    return response.json();
  }

  private async fetchMoltbookNotifications(since?: string): Promise<Omit<MoltxNotification, 'source'>[]> {
    const url = new URL('/notifications', this.moltbookBaseUrl);
    if (since) url.searchParams.set('since', since);
    
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.moltbookApiKey}`,
        'Accept': 'application/json',
      },
      signal: this.abortController?.signal,
    });
    
    if (!response.ok) {
      throw new Error(`Moltbook API error: ${response.status}`);
    }
    
    return response.json();
  }

  private async fetchMoltbookMentions(since?: string): Promise<Omit<MoltxMention, 'source'>[]> {
    const url = new URL('/feed/mentions', this.moltbookBaseUrl);
    if (since) url.searchParams.set('since', since);
    
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.moltbookApiKey}`,
        'Accept': 'application/json',
      },
      signal: this.abortController?.signal,
    });
    
    if (!response.ok) {
      throw new Error(`Moltbook API error: ${response.status}`);
    }
    
    return response.json();
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