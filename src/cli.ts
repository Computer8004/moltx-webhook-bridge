#!/usr/bin/env node
import { MoltxNotify } from './index.js';

interface CliArgs {
  apiKey?: string;
  baseUrl?: string;
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
      case '--api-key':
      case '-k':
        args.apiKey = argv[++i];
        break;
      case '--base-url':
      case '-b':
        args.baseUrl = argv[++i];
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
  if (!args.apiKey) args.apiKey = process.env.MOLTBOOK_API_KEY;
  if (!args.baseUrl) args.baseUrl = process.env.MOLTBOOK_BASE_URL;
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

Usage: moltx-notify [options]

Options:
  -k, --api-key <key>          Moltbook API key (required)
  -b, --base-url <url>         Moltbook base URL (default: https://www.moltbook.com/api/v1)
  -i, --poll-interval <ms>     Poll interval in ms (default: 30000)
  -o, --openclaw-url <url>     OpenClaw hooks URL (default: http://localhost:18789/hooks)
  -t, --openclaw-token <token> OpenClaw hooks token (optional)
  -h, --help                   Show this help

Environment Variables:
  MOLTBOOK_API_KEY             Your Moltbook API key
  MOLTBOOK_BASE_URL            Moltbook API base URL
  OPENCLAW_HOOKS_URL           OpenClaw gateway hooks URL
  OPENCLAW_HOOKS_TOKEN         OpenClaw hooks token (if required)
  POLL_INTERVAL                Poll interval in milliseconds

Examples:
  moltx-notify -k your_api_key_here
  moltx-notify -k xxx -i 60000 -o http://localhost:18789/hooks
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (!args.apiKey) {
    console.error('❌ Error: Moltbook API key is required.');
    console.error('   Get your API key from https://moltbook.com/settings');
    console.error('   Then run: moltx-notify -k YOUR_API_KEY');
    showHelp();
    process.exit(1);
  }

  const notify = new MoltxNotify({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    pollIntervalMs: args.pollInterval,
    openclawUrl: args.openclawUrl,
    openclawToken: args.openclawToken,
    onNotification: (n) => {
      console.log(`📨 Notification: ${n.type} from ${n.actorName}`);
    },
    onMention: (m) => {
      console.log(`💬 Mention from ${m.authorName}: ${m.content.slice(0, 50)}...`);
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
