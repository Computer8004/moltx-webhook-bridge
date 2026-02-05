#!/usr/bin/env node
import { MoltxNotify } from './index.js';

interface CliArgs {
  moltxApiKey?: string;
  moltbookApiKey?: string;
  pollInterval?: number;
  openclawUrl?: string;
  openclawToken?: string;
  help?: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};
  const argv = process.argv.slice(2);
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    
    switch (arg) {
      case '--moltx-key':
        args.moltxApiKey = argv[++i];
        break;
      case '--moltbook-key':
        args.moltbookApiKey = argv[++i];
        break;
      case '--poll-interval':
      case '-i':
        args.pollInterval = parseInt(argv[++i], 10);
        break;
      case '--openclaw-url':
      case '-o':
        args.openclawUrl = argv[++i];
        break;
      case '--openclaw-token':
      case '-t':
        args.openclawToken = argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
    }
  }

  // Check environment variables
  if (!args.moltxApiKey) args.moltxApiKey = process.env.MOLTX_API_KEY;
  if (!args.moltbookApiKey) args.moltbookApiKey = process.env.MOLTBOOK_API_KEY;
  if (!args.openclawUrl) args.openclawUrl = process.env.OPENCLAW_HOOKS_URL;
  if (!args.openclawToken) args.openclawToken = process.env.OPENCLAW_HOOKS_TOKEN;
  if (!args.pollInterval && process.env.POLL_INTERVAL) {
    args.pollInterval = parseInt(process.env.POLL_INTERVAL, 10);
  }

  return args;
}

function showHelp(): void {
  console.log(`
🦀 Moltx Notify - Free notification relay for AI agents

Supports both Moltx (moltx.io) and Moltbook (moltbook.com)

Usage: moltx-notify [options]

Options:
  --moltx-key <key>            Moltx API key (moltx.io)
  --moltbook-key <key>         Moltbook API key (moltbook.com)
  -i, --poll-interval <ms>     Poll interval in ms (default: 30000)
  -o, --openclaw-url <url>     OpenClaw hooks URL (default: http://localhost:18789/hooks)
  -t, --openclaw-token <token> OpenClaw hooks token (optional)
  -h, --help                   Show this help

Environment Variables:
  MOLTX_API_KEY                Your Moltx API key (moltx.io)
  MOLTBOOK_API_KEY             Your Moltbook API key (moltbook.com)
  OPENCLAW_HOOKS_URL           OpenClaw gateway hooks URL
  OPENCLAW_HOOKS_TOKEN         OpenClaw hooks token (if required)
  POLL_INTERVAL                Poll interval in milliseconds

Examples:
  # Poll only Moltx
  moltx-notify --moltx-key xxx

  # Poll only Moltbook
  moltx-notify --moltbook-key xxx

  # Poll both
  moltx-notify --moltx-key xxx --moltbook-key yyy
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (!args.moltxApiKey && !args.moltbookApiKey) {
    console.error('❌ Error: At least one API key required.');
    console.error('   Use --moltx-key for moltx.io');
    console.error('   Use --moltbook-key for moltbook.com');
    showHelp();
    process.exit(1);
  }

  const notify = new MoltxNotify({
    moltxApiKey: args.moltxApiKey,
    moltbookApiKey: args.moltbookApiKey,
    pollIntervalMs: args.pollInterval,
    openclawUrl: args.openclawUrl,
    openclawToken: args.openclawToken,
    onNotification: (n) => {
      console.log(`📨 [${n.source}] ${n.type} from ${n.actorName}`);
    },
    onMention: (m) => {
      console.log(`💬 [${m.source}] Mention from ${m.authorName}: ${m.content.slice(0, 50)}...`);
    },
    onError: (err) => {
      console.error('💥 Error:', err.message);
    },
  });

  // Handle shutdown gracefully
  const shutdown = () => {
    console.log('\n👋 Shutting down...');
    notify.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await notify.start();
  } catch (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }

  // Keep process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
