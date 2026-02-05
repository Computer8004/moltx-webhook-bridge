#!/usr/bin/env node
import { BridgeClient } from './index.js';

interface CliArgs {
  apiKey?: string;
  moltyId?: string;
  bridgeUrl?: string;
  openclawUrl?: string;
  openclawToken?: string;
  help?: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};
  const argv = process.argv.slice(2); // Skip node and script path
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    
    switch (arg) {
      case '--api-key':
      case '-k':
        args.apiKey = argv[++i];
        break;
      case '--molty-id':
      case '-m':
        args.moltyId = argv[++i];
        break;
      case '--bridge-url':
      case '-b':
        args.bridgeUrl = argv[++i];
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

  // Check environment variables as fallback
  if (!args.apiKey) args.apiKey = process.env.MOLTX_BRIDGE_API_KEY;
  if (!args.bridgeUrl) args.bridgeUrl = process.env.MOLTX_BRIDGE_URL;
  if (!args.openclawUrl) args.openclawUrl = process.env.OPENCLAW_HOOKS_URL;
  if (!args.openclawToken) args.openclawToken = process.env.OPENCLAW_HOOKS_TOKEN;

  return args;
}

function showHelp(): void {
  console.log(`
🦀 Moltx Bridge Client

Usage: moltx-bridge [options]

Options:
  -k, --api-key <key>          Bridge API key (required)
  -m, --molty-id <id>          Molty identifier (required)
  -b, --bridge-url <url>       Bridge server URL (default: https://bridge.moltx.io)
  -o, --openclaw-url <url>     OpenClaw hooks URL (default: http://localhost:18789/hooks)
  -t, --openclaw-token <token> OpenClaw hooks token (optional)
  -h, --help                   Show this help

Environment Variables:
  MOLTX_BRIDGE_API_KEY         Bridge API key
  MOLTX_BRIDGE_URL             Bridge server URL
  OPENCLAW_HOOKS_URL           OpenClaw hooks URL
  OPENCLAW_HOOKS_TOKEN         OpenClaw hooks token

Examples:
  moltx-bridge -k molty_xxx -m computer@moltx
  moltx-bridge -k molty_xxx -m computer@moltx -b https://bridge.example.com
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (!args.apiKey) {
    console.error('❌ Error: API key is required. Use --api-key or MOLTX_BRIDGE_API_KEY env var.');
    showHelp();
    process.exit(1);
  }

  if (!args.moltyId) {
    console.error('❌ Error: Molty ID is required. Use --molty-id or set it explicitly.');
    showHelp();
    process.exit(1);
  }

  const client = new BridgeClient({
    apiKey: args.apiKey,
    moltyId: args.moltyId,
    bridgeUrl: args.bridgeUrl,
    openclawUrl: args.openclawUrl,
    openclawToken: args.openclawToken,
    onConnected: () => {
      // Connected handler
    },
    onDisconnected: () => {
      console.log('💤 Disconnected from bridge');
    },
    onError: (error) => {
      console.error('💥 Client error:', error.message);
    }
  });

  // Handle shutdown gracefully
  const shutdown = () => {
    console.log('\n👋 Shutting down...');
    client.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.start();
  } catch (error) {
    console.error('❌ Failed to start client:', error);
    process.exit(1);
  }

  // Keep process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
