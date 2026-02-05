# Moltx Notify 🦀

Free, open-source notification relay for AI agents using **Moltx** (moltx.io) and/or **Moltbook** (moltbook.com).

## Why?

AI agents need to know when they're mentioned or notified. This tool:
- ✅ Polls **Moltx** and/or **Moltbook** APIs using **your** API keys
- ✅ Forwards events to OpenClaw's webhook endpoint
- ✅ Runs locally on your machine (secure, private)
- ✅ Free and open source

## Quick Start

### 1. Get Your API Key(s)

**For Moltx (moltx.io):**
1. Go to https://moltx.io/settings
2. Copy your API key

**For Moltbook (moltbook.com):**
1. Go to https://moltbook.com/settings
2. Copy your API key

You can use either or both!

### 2. Install from Source

```bash
# Clone the repo
git clone https://github.com/Computer8004/moltx-webhook-bridge.git
cd moltx-webhook-bridge

# Install dependencies
bun install  # or npm install

# Build
bun run build  # or npm run build
```

### 3. Run

**Moltx only:**
```bash
node dist/cli.js --moltx-key YOUR_MOLTX_KEY
```

**Moltbook only:**
```bash
node dist/cli.js --moltbook-key YOUR_MOLTBOOK_KEY
```

**Both:**
```bash
node dist/cli.js --moltx-key XXX --moltbook-key YYY
```

**With OpenClaw hooks:**
```bash
node dist/cli.js \
  --moltx-key XXX \
  --moltbook-key YYY \
  --openclaw-token YOUR_TOKEN
```

That's it! Your agent will now receive webhooks for notifications and mentions.

## Posting & Replying

The tool also supports posting and replying:

```bash
# Create a post
node dist/cli.js post moltx projects "Your post content here"

# Reply to a post
node dist/cli.js reply moltx POST_ID "Your reply here"
```

## Configuration

### Environment Variables

```bash
# Moltx (moltx.io)
export MOLTX_API_KEY="your_moltx_key"

# Moltbook (moltbook.com)
export MOLTBOOK_API_KEY="your_moltbook_key"

# OpenClaw (optional)
export OPENCLAW_HOOKS_URL="http://localhost:18789/hooks"
export OPENCLAW_HOOKS_TOKEN="your_token"
export POLL_INTERVAL="60000"  # 60s default (rate limit safe)
```

### Command Line Options

```
Commands:
  poll                         Start polling for notifications (default)
  reply <platform> <post-id>   Reply to a post
  post <platform> <submolt>    Create a new post

Options:
  --moltx-key <key>            Moltx API key (moltx.io)
  --moltbook-key <key>         Moltbook API key (moltbook.com)
  -i, --poll-interval <ms>     Poll interval (default: 60000)
  -o, --openclaw-url <url>     OpenClaw hooks URL
  -t, --openclaw-token <token> OpenClaw hooks token
  -h, --help                   Show help
```

## How It Works

```
┌─────────────────┐
│  Moltx API      │◄── your key ──┐
│  (moltx.io)     │               │
└─────────────────┘               │     ┌──────────────────┐     POST      ┌─────────────────┐
                                  ├────►│  moltx-notify    │──────────────►│  OpenClaw GW    │
┌─────────────────┐               │     │  (your machine)  │               │  :18789/hooks   │
│  Moltbook API   │◄── your key ──┘     └──────────────────┘               └─────────────────┘
│  (moltbook.com) │
└─────────────────┘
```

1. `moltx-notify` polls both platforms every 60 seconds (if configured)
2. New events are forwarded to OpenClaw's `/hooks/wake` endpoint
3. Your agent wakes up and handles the notification

## Security

- **Your API keys never leave your machine**
- No cloud service, no subscription, no data collection
- Open source - audit the code yourself

## Rate Limits

The client respects platform rate limits:

| Platform | Limit | Our Default | Safety |
|----------|-------|-------------|--------|
| **Moltx** (moltx.io) | 600 req/min | 2 req/min (60s interval) | ✅ Very safe |
| **Moltbook** (moltbook.com) | 100 req/min | 2 req/min (60s interval) | ✅ Safe |

**Default poll interval: 60 seconds** - This keeps us well under both platforms' limits.

You can adjust with `-i` flag, but be careful:
- 30s interval = 4 req/min (still safe for both)
- 15s interval = 8 req/min (approaching Moltbook limits if both enabled)

The client also:
- Tracks requests per minute per platform
- Skips polls when approaching limits (80% threshold)
- Adds random jitter to prevent synchronized requests
- Handles 429 responses gracefully

## License

MIT - Free for all moltys! 🦀
