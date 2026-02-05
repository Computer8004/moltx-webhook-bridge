// Moltx Notify - Free notification relay for AI agents
// Polls Moltx/Moltbook and forwards to OpenClaw

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
}

export interface MoltxMention {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  content: string;
  submolt?: string;
  createdAt: string;
}

export interface MoltxConfig {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  openclawUrl?: string;
  openclawToken?: string;
}

export class MoltxNotify {
  private apiKey: string;
  private baseUrl: string;
  private pollIntervalMs: number;
  private openclawUrl: string;
  private openclawToken: string;
  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private lastCheckTime = new Date(0);
  private onNotification?: (n: MoltxNotification) => void;
  private onMention?: (m: MoltxMention) => void;
  private onError?: (e: Error) => void;

  constructor(config: MoltxConfig & {
    onNotification?: (n: MoltxNotification) => void;
    onMention?: (m: MoltxMention) => void;
    onError?: (e: Error) => void;
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://www.moltbook.com/api/v1').replace(/\/$/, '');
    this.pollIntervalMs = config.pollIntervalMs ?? 30000;
    this.openclawUrl = (config.openclawUrl ?? 'http://localhost:18789/hooks').replace(/\/$/, '');
    this.openclawToken = config.openclawToken ?? '';
    this.onNotification = config.onNotification;
    this.onMention = config.onMention;
    this.onError = config.onError;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    
    console.log('🦀 Moltx Notify starting...');
    console.log(`   Polling: ${this.baseUrl}`);
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
    const since = this.lastCheckTime.toISOString();
    
    try {
      // Fetch notifications
      const notifications = await this.fetchNotifications(since);
      for (const notification of notifications) {
        if (!notification.read) {
          this.onNotification?.(notification);
          await this.forwardToOpenClaw('notification', notification);
        }
      }
      
      // Fetch mentions
      const mentions = await this.fetchMentions(since);
      for (const mention of mentions) {
        this.onMention?.(mention);
        await this.forwardToOpenClaw('mention', mention);
      }
      
      this.lastCheckTime = new Date();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw err;
    }
  }

  private async fetchNotifications(since?: string): Promise<MoltxNotification[]> {
    const url = new URL('/notifications', this.baseUrl);
    if (since) url.searchParams.set('since', since);
    
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json',
      },
      signal: this.abortController?.signal,
    });
    
    if (!response.ok) {
      throw new Error(`Moltx API error: ${response.status} ${await response.text()}`);
    }
    
    return response.json();
  }

  private async fetchMentions(since?: string): Promise<MoltxMention[]> {
    const url = new URL('/feed/mentions', this.baseUrl);
    if (since) url.searchParams.set('since', since);
    
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json',
      },
      signal: this.abortController?.signal,
    });
    
    if (!response.ok) {
      throw new Error(`Moltx API error: ${response.status} ${await response.text()}`);
    }
    
    return response.json();
  }

  private async forwardToOpenClaw(type: string, data: unknown): Promise<void> {
    const payload = {
      text: `Moltx ${type}: ${JSON.stringify(data).slice(0, 100)}...`,
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
        console.log(`✅ Forwarded ${type} to OpenClaw`);
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