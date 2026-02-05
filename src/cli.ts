import { MoltxNotify } from './index.js';

interface CliArgs {
  command?: 'poll' | 'reply' | 'post' | 'help';
  platform?: 'moltx' | 'moltbook';
  postId?: string;
  submolt?: string;
  content?: string;
  moltxApiKey?: string;
  moltbookApiKey?: string;
  pollInterval?: number;
  openclawUrl?: string;
  openclawToken?: string;
  discordChannel?: string;
  help?: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};
  const argv = process.argv.slice(2);

  // First arg might be a command
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    const cmd = argv.shift();
    if (cmd === 'poll' || cmd === 'reply' || cmd === 'post' || cmd === 'help') {
      args.command = cmd;
    }
  }

  // Default command is poll
  if (!args.command) args.command = 'poll';

  // Extract positional args for reply/post commands
  if (args.command === 'reply' && argv.length >= 2) {
    args.platform = argv.shift() as 'moltx' | 'moltbook';
    args.postId = argv.shift();
    // Remaining args are content
    if (argv.length > 0 && !argv[0].startsWith('-')) {
      args.content = argv.shift();
    }
  } else if (args.command === 'post' && argv.length >= 1) {
    args.platform = argv.shift() as 'moltx' | 'moltbook';
    if (argv.length > 0 && !argv[0].startsWith('-')) {
      args.submolt = argv.shift();
    }
    // Remaining args are content
    if (argv.length > 0 && !argv[0].startsWith('-')) {
      args.content = argv.shift();
    }
  }

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
      case '--discord-channel':
      case '-d':
        args.discordChannel = argv[++i];
        break;
      case '--platform':
      case '-p':
        args.platform = argv[++i] as 'moltx' | 'moltbook';
        break;
      case '--post-id':
        args.postId = argv[++i];
        break;
      case '--submolt':
      case '-s':
        args.submolt = argv[++i];
        break;
      case '--content':
      case '-c':
        args.content = argv[++i];
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
  if (!args.discordChannel) args.discordChannel = process.env.DISCORD_CHANNEL;
  if (!args.pollInterval && process.env.POLL_INTERVAL) {
    args.pollInterval = parseInt(process.env.POLL_INTERVAL, 10);
  }

  return args;
}

function showHelp(): void {
  console.log(`
🦀 Moltx Notify - Free notification relay for AI agents

Supports both Moltx (moltx.io) and Moltbook (moltbook.com)

Usage: moltx-notify <command> [options]

Commands:
  poll                         Start polling for notifications (default)
  reply <platform> <post-id>   Reply to a post
  post <platform> <submolt>    Create a new post

Options:
  --moltx-key <key>            Moltx API key (moltx.io)
  --moltbook-key <key>         Moltbook API key (moltbook.com)
  -i, --poll-interval <ms>     Poll interval in ms (default: 60000)
  -o, --openclaw-url <url>     OpenClaw hooks URL (default: http://localhost:18789/hooks)
  -t, --openclaw-token <token> OpenClaw hooks token (optional)
  -d, --discord-channel <id>   Discord channel ID for cross-posting responses
  -p, --platform <name>        Platform: moltx or moltbook
  --post-id <id>               Post ID to reply to
  -s, --submolt <name>         Submolt to post in
  -c, --content <text>         Content of reply/post
  -h, --help                   Show this help

Environment Variables:
  MOLTX_API_KEY                Your Moltx API key (moltx.io)
  MOLTBOOK_API_KEY             Your Moltbook API key (moltbook.com)
  OPENCLAW_HOOKS_URL           OpenClaw gateway hooks URL
  OPENCLAW_HOOKS_TOKEN         OpenClaw hooks token (if required)
  DISCORD_CHANNEL              Discord channel ID for cross-posting responses
  POLL_INTERVAL                Poll interval in milliseconds

Examples:
  # Poll for notifications
  moltx-notify --moltx-key xxx --moltbook-key yyy

  # Reply to a Moltx post
  moltx-notify reply moltx 12345 "Thanks for the mention!"

  # Create a post on Moltbook
  moltx-notify post moltbook meta "Hello world!"
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Handle reply command
  if (args.command === 'reply') {
    if (!args.platform || !args.postId || !args.content) {
      console.error('❌ Error: reply requires platform, post-id, and content');
      console.error('   Usage: moltx-notify reply <moltx|moltbook> <post-id> "your message"');
      process.exit(1);
    }

    const notify = new MoltxNotify({
      moltxApiKey: args.moltxApiKey,
      moltbookApiKey: args.moltbookApiKey,
    });

    try {
      if (args.platform === 'moltx') {
        await notify.replyToMoltx(args.postId, args.content);
      } else if (args.platform === 'moltbook') {
        await notify.replyToMoltbook(args.postId, args.content);
      } else {
        console.error('❌ Error: platform must be "moltx" or "moltbook"');
        process.exit(1);
      }
      process.exit(0);
    } catch (error) {
      console.error('❌ Failed to reply:', error);
      process.exit(1);
    }
  }

  // Handle post command
  if (args.command === 'post') {
    if (!args.platform || !args.content) {
      console.error('❌ Error: post requires platform and content');
      console.error('   Usage: moltx-notify post <moltx|moltbook> <submolt> "your message"');
      process.exit(1);
    }

    const notify = new MoltxNotify({
      moltxApiKey: args.moltxApiKey,
      moltbookApiKey: args.moltbookApiKey,
    });

    try {
      if (args.platform === 'moltx') {
        await notify.createMoltxPost(args.submolt || 'general', args.content);
      } else if (args.platform === 'moltbook') {
        await notify.createMoltbookPost(args.submolt || 'general', args.content);
      } else {
        console.error('❌ Error: platform must be "moltx" or "moltbook"');
        process.exit(1);
      }
      process.exit(0);
    } catch (error) {
      console.error('❌ Failed to post:', error);
      process.exit(1);
    }
  }

  // Poll command (default)
  if (!args.moltxApiKey && !args.moltbookApiKey) {
    console.error('❌ Error: At least one API key required for polling.');
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
    discordChannel: args.discordChannel,
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
