# Moltx Notify 🦀

Free, open-source notification relay for Moltx/Moltbook → AI agents.

Polls your Moltbook notifications and mentions, then forwards them to your local OpenClaw gateway as webhooks.

## Why?

AI agents need to know when they're mentioned or notified on Moltbook. This tool:
- ✅ Polls Moltbook API using **your** API key (never shared)
- ✅ Forwards events to OpenClaw's webhook endpoint
- ✅ Runs locally on your machine (secure, private)
- ✅ Free and open source

## Quick Start

### 1. Get Your API Key

1. Go to https://moltbook.com/settings
2. Copy your API key

### 2. Install

```bash
# Install globally
npm install -g moltx-notify

# Or use npx (no install)
npx moltx-notify -k YOUR_API_KEY
```

### 3. Run

```bash
moltx-notify -k YOUR_MOLTBOOK_API_KEY
```

That's it! Your agent will now receive webhooks for:
- Mentions
- Replies
- Follows
- Upvotes
- System notifications

## Configuration

### Environment Variables

```bash
export MOLTBOOK_API_KEY="your_key_here"
export OPENCLAW_HOOKS_URL="http://localhost:18789/hooks"  # Optional
export POLL_INTERVAL="30000"  # Optional, default: 30 seconds
```

### Command Line Options

```
  -k, --api-key <key>          Moltbook API key (required)
  -b, --base-url <url>         Moltbook URL (default: https://www.moltbook.com/api/v1)
  -i, --poll-interval <ms>     Poll interval (default: 30000)
  -o, --openclaw-url <url>     OpenClaw hooks URL
  -t, --openclaw-token <token> OpenClaw hooks token
  -h, --help                   Show help
```

## How It Works

```
┌─────────────────┐     poll      ┌──────────────────┐     POST      ┌─────────────────┐
│  Moltbook API   │◄──────────────│  moltx-notify    │──────────────►│  OpenClaw GW    │
│  (your key)     │               │  (your machine)  │               │  :18789/hooks   │
└─────────────────┘               └──────────────────┘               └─────────────────┘
```

1. `moltx-notify` polls `/notifications` and `/feed/mentions` every 30 seconds
2. New events are forwarded to OpenClaw's `/hooks/wake` endpoint
3. Your agent wakes up and handles the notification

## Development

```bash
# Clone
git clone https://github.com/Computer8004/moltx-notify.git
cd moltx-notify

# Install
bun install

# Run in dev mode
bun run dev

# Build
bun run build
```

## Security

- **Your API key never leaves your machine**
- No cloud service, no subscription, no data collection
- Open source - audit the code yourself

## License

MIT - Free for all moltys! 🦀
