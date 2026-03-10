#!/usr/bin/env bun
/**
 * SCAR Dashboard - Beautiful TUI for monitoring SCARGate
 *
 * Run: bun dashboard.ts
 */

const DAEMON_PORT = 3773;
const REFRESH_INTERVAL = 2000;

// Beautiful color palette
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Brand colors
  scar: '\x1b[38;5;196m',      // Red-pink
  safe: '\x1b[38;5;82m',       // Green
  warn: '\x1b[38;5;214m',      // Orange
  info: '\x1b[38;5;51m',       // Cyan
  purple: '\x1b[38;5;141m',    // Purple
  accent: '\x1b[38;5;163m',    // Bright pink
  dimScar: '\x1b[38;5;168m',
  dimSafe: '\x1b[38;5;72m',
  dimWarn: '\x1b[38;5;180m',
  dimInfo: '\x1b[38;5;74m',
  dimPurple: '\x1b[38;5;140m',
  // Brights
  bright: '\x1b[1m',
  brightPurple: '\x1b[38;5;183m',
  brightCyan: '\x1b[38;5;159m',
  // Box drawing
  tl: '\u256D', tr: '\u256E', bl: '\u2570', br: '\u256F',
  h: '\u2500', v: '\u2502',
};

// Box drawing helpers
function boxLine(width: number, color: string = C.scar): string {
  return color + C.tl + C.h.repeat(width - 2) + C.tr + C.reset;
}

function boxBottom(width: number, color: string = C.scar): string {
  return color + C.bl + C.h.repeat(width - 2) + C.br + C.reset;
}

function boxText(text: string, width: number, color: string = C.scar): string {
  const padded = text.padEnd(width - 4);
  return color + C.v + C.reset + ' ' + padded + ' ' + color + C.v + C.reset;
}

// Fetch daemon data
async function fetchEndpoint(endpoint: string): Promise<any> {
  try {
    const res = await fetch(`http://localhost:${DAEMON_PORT}${endpoint}`);
    return await res.json();
  } catch {
    return null;
  }
}

// Clear screen
function clearScreen(): void {
  console.clear();
  // Alternative: process.stdout.write('\x1b[2J\x1b[H');
}

// Render dashboard
async function render(): Promise<string[]> {
  const width = 80;
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(boxLine(width));
  lines.push(boxText(`${C.bold}${C.scar}  SCARGate Dashboard${C.reset}`, width));
  lines.push(boxBottom(width));
  lines.push('');

  // Fetch daemon status
  const [health, status, stats, blocks] = await Promise.all([
    fetchEndpoint('/health'),
    fetchEndpoint('/status'),
    fetchEndpoint('/stats'),
    fetchEndpoint('/blocks'),
  ]);

  if (!health) {
    lines.push(`${C.warn}${C.bold}  Daemon Offline${C.reset}`);
    lines.push(`${C.dim}  Could not connect to port ${DAEMON_PORT}${C.reset}`);
    lines.push('');
    lines.push(`${C.info}  Start with: cd ~/.claude/PAI/SCAR && bun scar-daemon.ts start${C.reset}`);
    lines.push('');
    return lines;
  }

  // Daemon status
  const uptime = status?.uptime || 0;
  const uptimeStr = uptime < 60
    ? `${Math.floor(uptime)}s`
    : uptime < 3600
      ? `${Math.floor(uptime / 60)}m`
      : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  lines.push(`${C.safe}${C.bold}  Daemon Online${C.reset} ${C.dim}│${C.reset} Port: ${DAEMON_PORT} ${C.dim}│${C.reset} Uptime: ${uptimeStr} ${C.dim}│${C.reset} Scars: ${health.scarsLoaded || 0}`);
  lines.push('');

  // Statistics
  if (stats) {
    lines.push(`${C.purple}${C.bold}  Statistics${C.reset}`);
    lines.push(`  Total blocks: ${stats.totalBlocks || 0}   ${C.dim}│${C.reset}   Today: ${stats.todayBlocks || 0}`);
    lines.push('');
  }

  // Top principles
  if (stats?.principleHits) {
    lines.push(`${C.purple}${C.bold}  Top Principles Triggered${C.reset}`);

    const topPrinciples = Object.entries(stats.principleHits)
      .sort((a: any, b: any) => b[1] - a[1])
      .slice(0, 5);

    if (topPrinciples.length > 0) {
      for (const [principle, count] of topPrinciples) {
        const bar = '\u2588'.repeat(Math.min(count as number, 10));
        lines.push(`  ${C.accent}${principle}${C.reset}  ${C.dimSafe}${bar}${C.reset} ${count}`);
      }
    } else {
      lines.push(`  ${C.dim}No principles triggered yet${C.reset}`);
    }
    lines.push('');
  }

  // Recent blocks
  lines.push(`${C.purple}${C.bold}  Recent Blocked Actions${C.reset}`);

  if (blocks && blocks.length > 0) {
    const recent = blocks.slice(-5).reverse();
    for (const block of recent) {
      const time = block.timestamp ? new Date(block.timestamp).toLocaleTimeString() : 'Unknown';
      const principle = block.principle || 'Unknown';
      const relevance = block.relevance ? `${Math.round(block.relevance * 100)}%` : '';
      const action = block.context ? block.context.substring(0, 40) + '...' : '';

      lines.push(`  ${C.dim}${time}${C.reset}  ${C.scar}\u{1F6D1}${C.reset} ${action}`);
      lines.push(`           ${C.accent}${principle}${C.reset} @ ${relevance}`);
      lines.push('');
    }
  } else {
    lines.push(`  ${C.dim}No blocks recorded yet${C.reset}`);
    lines.push(`  ${C.dim}   No activity detected${C.reset}`);
    lines.push('');
  }

  // Footer
  lines.push(C.dim + '\u2500'.repeat(width - 20) + C.reset);
  lines.push(`${C.dim}  Press q to quit ${C.reset}${C.dim}│${C.reset}${C.dim} r to refresh ${C.reset}${C.dim}│${C.reset}${C.dim} Auto-refresh: ${REFRESH_INTERVAL}ms${C.reset}`);

  return lines;
}

// Main loop
async function main() {
  // Set raw mode for key input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
  }

  let running = true;

  // Key handler
  process.stdin.on('data', async (key: string) => {
    if (key === 'q' || key === '\u0003') { // q or Ctrl+C
      running = false;
      clearScreen();
      console.log(`${C.info}Goodbye!${C.reset}`);
      process.exit(0);
    }
    if (key === 'r') {
      clearScreen();
      const lines = await render();
      console.log(lines.join('\n'));
    }
  });

  // Initial render
  clearScreen();
  const lines = await render();
  console.log(lines.join('\n'));

  // Auto-refresh loop
  while (running) {
    await new Promise(r => setTimeout(r, REFRESH_INTERVAL));
    if (running) {
      clearScreen();
      const lines = await render();
      console.log(lines.join('\n'));
    }
  }
}

main().catch(console.error);
