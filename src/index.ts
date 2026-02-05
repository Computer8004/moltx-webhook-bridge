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
  discordChannel?: string; // Discord channel ID to cross-post responses
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
  private discordChannel?: string;
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
    this.moltxBaseUrl = (config.moltxBaseUrl ?? 'https://moltx.io/v1').replace(/\/?$/, '/');
    this.moltbookApiKey = config.moltbookApiKey;
    this.moltbookBaseUrl = (config.moltbookBaseUrl ?? 'https://www.moltbook.com/api/v1').replace(/\/?$/, '/');
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.openclawUrl = (config.openclawUrl ?? 'http://localhost:18789/hooks').replace(/\/$/, '');
    this.openclawToken = config.openclawToken ?? '';
    this.enableJitter = config.enableJitter ?? true;
    this.discordChannel = config.discordChannel;
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
    const url = new URL('notifications', this.moltxBaseUrl);
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
    
    const data = await response.json();
    return data.data?.notifications || [];
  }

  private async fetchMoltxMentions(since?: string): Promise<Omit<MoltxMention, 'source'>[]> {
    const url = new URL('feed/mentions', this.moltxBaseUrl);
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
    
    const data = await response.json();
    return data.data?.posts || [];
  }

  private lastMoltbookProfile: { postCount: number; karma: number; commentCount: number } | null = null;

  private async fetchMoltbookNotifications(since?: string): Promise<Omit<MoltxNotification, 'source'>[]> {
    // Moltbook doesn't have a notifications endpoint
    // Track by polling profile and detecting changes
    const notifications: Omit<MoltxNotification, 'source'>[] = [];
    
    try {
      const profile = await this.fetchMoltbookProfile();
      
      if (this.lastMoltbookProfile) {
        // Detect new posts
        if (profile.postCount > this.lastMoltbookProfile.postCount) {
          const newPosts = profile.postCount - this.lastMoltbookProfile.postCount;
          notifications.push({
            id: `moltbook-post-${Date.now()}`,
            type: 'system',
            actorId: 'self',
            actorName: 'You',
            content: `Your post count increased by ${newPosts}`,
            read: false,
            createdAt: new Date().toISOString(),
          });
        }
        
        // Detect karma changes (upvotes/downvotes)
        if (profile.karma > this.lastMoltbookProfile.karma) {
          const karmaGain = profile.karma - this.lastMoltbookProfile.karma;
          notifications.push({
            id: `moltbook-karma-${Date.now()}`,
            type: 'upvote',
            actorId: 'unknown',
            actorName: 'Someone',
            content: `+${karmaGain} karma from upvotes`,
            read: false,
            createdAt: new Date().toISOString(),
          });
        }
        
        // Detect new comments
        if (profile.commentCount > this.lastMoltbookProfile.commentCount) {
          const newComments = profile.commentCount - this.lastMoltbookProfile.commentCount;
          notifications.push({
            id: `moltbook-comment-${Date.now()}`,
            type: 'reply',
            actorId: 'unknown',
            actorName: 'Someone',
            content: `${newComments} new comment(s) on your posts`,
            read: false,
            createdAt: new Date().toISOString(),
          });
        }
      }
      
      this.lastMoltbookProfile = profile;
    } catch (err) {
      console.error('[moltbook.com] Profile fetch error:', err);
    }
    
    return notifications;
  }
  
  private async fetchMoltbookProfile(): Promise<{ postCount: number; karma: number; commentCount: number }> {
    const response = await fetch(`${this.moltbookBaseUrl}/agents/me`, {
      headers: {
        'Authorization': `Bearer ${this.moltbookApiKey}`,
        'Accept': 'application/json',
      },
      signal: this.abortController?.signal,
    });
    
    if (!response.ok) {
      throw new Error(`Moltbook API error: ${response.status}`);
    }
    
    const data = await response.json();
    return {
      postCount: data.agent?.post_count || 0,
      karma: data.agent?.karma || 0,
      commentCount: data.agent?.comment_count || 0,
    };
  }

  private lastSeenMoltbookPostIds = new Set<string>();

  private async fetchMoltbookMentions(since?: string): Promise<Omit<MoltxMention, 'source'>[]> {
    // Moltbook doesn't have a mentions endpoint
    // Search feed for posts mentioning us
    const mentions: Omit<MoltxMention, 'source'>[] = [];
    
    try {
      // Get my profile to find my name
      const meResponse = await fetch(`${this.moltbookBaseUrl}/agents/me`, {
        headers: {
          'Authorization': `Bearer ${this.moltbookApiKey}`,
          'Accept': 'application/json',
        },
        signal: this.abortController?.signal,
      });
      
      if (!meResponse.ok) return [];
      const meData = await meResponse.json();
      const myName = meData.agent?.name;
      
      if (!myName) return [];
      
      // Search for posts mentioning us
      const searchResponse = await fetch(
        `${this.moltbookBaseUrl}/search?q=${encodeURIComponent('@' + myName)}&type=posts&limit=20`,
        {
          headers: {
            'Authorization': `Bearer ${this.moltbookApiKey}`,
            'Accept': 'application/json',
          },
          signal: this.abortController?.signal,
        }
      );
      
      if (!searchResponse.ok) return [];
      const searchData = await searchResponse.json();
      
      for (const result of searchData.results || []) {
        // Skip if we've seen this before
        if (this.lastSeenMoltbookPostIds.has(result.id)) continue;
        
        // Check if content actually mentions us
        if (result.content?.includes('@' + myName)) {
          mentions.push({
            id: result.id,
            postId: result.post_id || result.id,
            authorId: result.author?.id || 'unknown',
            authorName: result.author?.name || 'Unknown',
            content: result.content.slice(0, 200),
            submolt: result.submolt?.name,
            createdAt: result.created_at,
          });
          this.lastSeenMoltbookPostIds.add(result.id);
        }
      }
      
      // Keep set size manageable
      if (this.lastSeenMoltbookPostIds.size > 100) {
        const toDelete = this.lastSeenMoltbookPostIds.size - 100;
        const iter = this.lastSeenMoltbookPostIds.values();
        for (let i = 0; i < toDelete; i++) {
          const value = iter.next().value;
          if (value) this.lastSeenMoltbookPostIds.delete(value);
        }
      }
    } catch (err) {
      console.error('[moltbook.com] Search error:', err);
    }
    
    return mentions;
  }

  // Reply methods for manual response workflow
  async replyToMoltx(postId: string, content: string): Promise<boolean> {
    if (!this.moltxApiKey) {
      throw new Error('Moltx API key not configured');
    }

    const url = new URL(`posts/${postId}/reply`, this.moltxBaseUrl);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.moltxApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to reply: ${response.status} - ${error}`);
    }

    console.log(`✅ Replied to Moltx post ${postId}`);
    return true;
  }

  async replyToMoltbook(postId: string, content: string): Promise<boolean> {
    if (!this.moltbookApiKey) {
      throw new Error('Moltbook API key not configured');
    }

    const response = await fetch(`${this.moltbookBaseUrl}/posts/${postId}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.moltbookApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to reply: ${response.status} - ${error}`);
    }

    console.log(`✅ Replied to Moltbook post ${postId}`);
    return true;
  }

  async createMoltxPost(submolt: string, content: string, parentId?: string): Promise<boolean> {
    if (!this.moltxApiKey) {
      throw new Error('Moltx API key not configured');
    }

    const url = new URL('posts', this.moltxBaseUrl);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.moltxApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ submolt, content, parent_id: parentId }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create post: ${response.status} - ${error}`);
    }

    console.log(`✅ Created Moltx post in ${submolt}`);
    return true;
  }

  async createMoltbookPost(submoltId: string, content: string, parentId?: string): Promise<boolean> {
    if (!this.moltbookApiKey) {
      throw new Error('Moltbook API key not configured');
    }

    const response = await fetch(`${this.moltbookBaseUrl}/posts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.moltbookApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        submolt_id: submoltId,
        content,
        parent_id: parentId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create post: ${response.status} - ${error}`);
    }

    console.log(`✅ Created Moltbook post`);
    return true;
  }

  private async forwardToOpenClaw(type: string, data: unknown, source: string): Promise<void> {
    const payload: Record<string, unknown> = {
      text: `📨 [${source}] ${type}: ${JSON.stringify(data).slice(0, 200)}...\n\nReply with: moltx-notify reply ${source} <post-id> "your message"`,
      mode: 'now' as const,
    };

    // Include discord channel for cross-posting responses
    if (this.discordChannel) {
      payload.discordChannel = this.discordChannel;
    }

    // Include the full notification data for context
    payload.moltxData = {
      type,
      source,
      data,
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