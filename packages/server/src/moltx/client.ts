import type { MoltxNotification, MoltxMention, MoltxPost } from '@moltx/bridge-types';

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY;
const MOLTBOOK_BASE_URL = process.env.MOLTBOOK_BASE_URL ?? 'https://www.moltbook.com/api/v1';

if (!MOLTBOOK_API_KEY) {
  console.warn('[moltx-client] MOLTBOOK_API_KEY not set - Moltx integration disabled');
}

interface MoltxClientOptions {
  baseUrl?: string;
  apiKey?: string;
  onNotification?: (notification: MoltxNotification) => void | Promise<void>;
  onMention?: (mention: MoltxMention) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export class MoltxClient {
  private baseUrl: string;
  private apiKey: string;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private options: MoltxClientOptions;
  private lastCheckTime = new Date(0);

  constructor(options: MoltxClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? MOLTBOOK_BASE_URL;
    this.apiKey = options.apiKey ?? MOLTBOOK_API_KEY ?? '';
    this.options = options;
  }

  async start(pollIntervalMs = 30000): Promise<void> {
    if (this.isRunning) return;
    
    if (!this.apiKey) {
      throw new Error('MOLTBOOK_API_KEY required to start Moltx client');
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    
    console.log('[moltx-client] Starting polling...');
    
    // Initial fetch
    await this.checkNotifications();
    
    // Start polling
    this.pollInterval = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        await this.checkNotifications();
      } catch (err) {
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }, pollIntervalMs);
  }

  stop(): void {
    console.log('[moltx-client] Stopping...');
    this.isRunning = false;
    this.abortController?.abort();
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async checkNotifications(): Promise<void> {
    const since = this.lastCheckTime.toISOString();
    
    try {
      // Check notifications
      const notifications = await this.fetchNotifications(since);
      for (const notification of notifications) {
        await this.options.onNotification?.(notification);
      }

      // Check mentions
      const mentions = await this.fetchMentions(since);
      for (const mention of mentions) {
        await this.options.onMention?.(mention);
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
      throw new Error(`Failed to fetch notifications: ${response.status} ${await response.text()}`);
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
      throw new Error(`Failed to fetch mentions: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  // Get user's feed (for self-posting)
  async getFollowingFeed(limit = 20): Promise<MoltxPost[]> {
    const url = new URL('/feed/following', this.baseUrl);
    url.searchParams.set('limit', limit.toString());

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch feed: ${response.status}`);
    }

    return response.json();
  }

  // Post to Moltbook (optional feature)
  async createPost(content: string, options: { replyTo?: string; submolt?: string } = {}): Promise<MoltxPost> {
    const response = await fetch(`${this.baseUrl}/posts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        content,
        reply_to_id: options.replyTo,
        submolt_id: options.submolt,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create post: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }
}

// Factory function
export function createMoltxClient(options: MoltxClientOptions = {}): MoltxClient {
  return new MoltxClient(options);
}