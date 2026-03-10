#!/usr/bin/env bun
/**
 * SCAR Dashboard - TUI for monitoring SCARGate
 *
 * Run: bun dashboard.ts
 *
 * Shows:
 * - Live block count
 * - Recent blocked actions
 * - Principle hit statistics
 * - Daemon health
 */

const DAEMON_PORT = 3773;
const REFRESH_INTERVAL = 2000; // 2 seconds

// ANSI escape codes
const ANSI = {
  clear: '\x1b[2J\x1b[H',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

interface DaemonStatus {
  scarsLoaded: number;
  lastLoaded: string;
  matchesTriggered: number;
}

interface Stats {
  totalBlocks: number;
  todayBlocks: number;
  principleHits: Record<string, number>;
}

interface BlockLog {
  timestamp: string;
  context: string;
  scar_id: string;
  relevance: number;
  blocked: boolean;
}

// State
let daemonStatus: DaemonStatus | null = null;
let stats: Stats | null = null;
let blocks: BlockLog[] = [];
let running = true;

// Fetch daemon status
async function fetchStatus(): Promise<DaemonStatus | null> {
  try {
    const response = await fetch(`http://localhost:${DAEMON_PORT}/status`, {
      signal: AbortSignal.timeout(1000)
    });
    return await response.json();
  } catch {
    return null;
  }
}

// Fetch stats
async function fetchStats(): Promise<Stats | null> {
  try {
    const response = await fetch(`http://localhost:${DAEMON_PORT}/stats`, {
      signal: AbortSignal.timeout(1000)
    });
    return await response.json();
  } catch {
    return null;
  }
}

// Fetch blocks
async function fetchBlocks(): Promise<BlockLog[]> {
  try {
    const response = await fetch(`http://localhost:${DAEMON_PORT}/blocks?limit=20`, {
      signal: AbortSignal.timeout(1000)
    });
    return await response.json();
  } catch {
    return [];
  }
}

// Render dashboard
function render(): string {
  const lines: string[] = [];
  const width = 80;

  // Header
  lines.push('');
  lines.push(`${ANSI.cyan}${ANSI.bold}╔${'═'.repeat(width - 2)}╗${ANSI.reset}`);
  lines.push(`${ANSI.cyan}${ANSI.bold}║${ANSI.reset}${ANSI.bold}                    🛡️  SCARGate Dashboard${' '.repeat(width - 45)}${ANSI.cyan}${ANSI.bold}║${ANSI.reset}`);
  lines.push(`${ANSI.cyan}${ANSI.bold}╚${'═'.repeat(width - 2)}╝${ANSI.reset}`);
  lines.push('');

  // Daemon status
  if (daemonStatus) {
    const uptime = Math.floor((Date.now() - new Date(daemonStatus.lastLoaded).getTime()) / 1000 / 60);
    lines.push(`${ANSI.green}● Daemon Online${ANSI.reset}  │  Port: ${DAEMON_PORT}  │  Uptime: ${uptime}m  │  Scars: ${daemonStatus.scarsLoaded}`);
  } else {
    lines.push(`${ANSI.red}● Daemon Offline${ANSI.reset}  │  Run: ${ANSI.yellow}systemctl --user start scar-daemon${ANSI.reset}`);
  }
  lines.push(`${ANSI.dim}${'─'.repeat(width)}${ANSI.reset}`);
  lines.push('');

  // Stats
  if (stats) {
    lines.push(`${ANSI.bold}Statistics${ANSI.reset}`);
    lines.push(`  Total blocks: ${ANSI.red}${stats.totalBlocks}${ANSI.reset}   │   Today: ${ANSI.yellow}${stats.todayBlocks}${ANSI.reset}`);
    lines.push('');

    // Principle hits
    if (Object.keys(stats.principleHits).length > 0) {
      lines.push(`${ANSI.bold}Top Principles Triggered${ANSI.reset}`);
      const sorted = Object.entries(stats.principleHits)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      for (const [id, count] of sorted) {
        const bar = '█'.repeat(Math.min(count, 20));
        lines.push(`  ${ANSI.magenta}${id.padEnd(4)}${ANSI.reset} ${bar} ${count}`);
      }
      lines.push('');
    }
  }

  // Recent blocks
  lines.push(`${ANSI.bold}Recent Blocked Actions${ANSI.reset}`);
  const recentBlocks = blocks.filter(b => b.blocked).slice(-5).reverse();

  if (recentBlocks.length === 0) {
    lines.push(`  ${ANSI.dim}No blocks recorded yet${ANSI.reset}`);
  } else {
    for (const block of recentBlocks) {
      const time = new Date(block.timestamp).toLocaleTimeString();
      const context = block.context?.slice(0, 40) || 'Unknown';
      lines.push(`  ${ANSI.dim}${time}${ANSI.reset}  ${ANSI.red}🛔${ANSI.reset} ${context}...`);
      lines.push(`           ${ANSI.yellow}${block.scar_id}${ANSI.reset} @ ${(block.relevance * 100).toFixed(0)}%`);
    }
  }

  lines.push('');
  lines.push(`${ANSI.dim}${'─'.repeat(width)}${ANSI.reset}`);
  lines.push(`${ANSI.dim}Press q to quit │ r to refresh │ Auto-refresh: ${REFRESH_INTERVAL}ms${ANSI.reset}`);

  return lines.join('\n');
}

// Main loop
async function main() {
  // Check if running in TTY
  const isTTY = process.stdin.isTTY;

  // Hide cursor (only in TTY)
  if (isTTY) {
    process.stdout.write(ANSI.hideCursor);
    process.stdin.setRawMode(true);
    process.stdin.on('data', (key) => {
      const char = key.toString();
      if (char === 'q' || char === '\x03') {
        running = false;
        process.stdout.write(ANSI.showCursor);
        process.stdout.write(ANSI.clear);
        console.log('Goodbye!');
        process.exit(0);
      }
      if (char === 'r') {
        update();
      }
    });
  }

  // Handle cleanup
  process.on('exit', () => {
    process.stdout.write(ANSI.showCursor);
  });

  async function update() {
    daemonStatus = await fetchStatus();
    stats = await fetchStats();
    blocks = await fetchBlocks();

    // Render
    process.stdout.write(ANSI.clear);
    process.stdout.write(render());
  }

  // Initial render
  await update();

  // If not TTY, just render once and exit
  if (!isTTY) {
    process.exit(0);
  }

  // Refresh loop (only in TTY mode)
  while (running) {
    await new Promise(r => setTimeout(r, REFRESH_INTERVAL));
    if (running) {
      await update();
    }
  }
}

main().catch(e => {
  process.stdout.write(ANSI.showCursor);
  console.error('Dashboard error:', e);
  process.exit(1);
});
