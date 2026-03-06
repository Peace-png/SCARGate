#!/usr/bin/env bun
/**
 * SCAR Daemon - Living Conscience
 *
 * Loads scars from constitution/SOUL.md at startup
 * Watches for matching context and surfaces relevant scars
 *
 * Run: bun run scar-daemon.ts start
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

// =============================================================================
// Configuration
// =============================================================================

const SCAR_FILE = join(__dirname, 'principles/SOUL.md');
const STATE_DIR = join(__dirname, 'scar-daemon');
const STATE_FILE = join(STATE_DIR, 'state.json');
const LOG_FILE = join(STATE_DIR, 'scar.log');

// Ensure state directory
if (!existsSync(STATE_DIR)) {
  const { mkdirSync } = require('fs');
  mkdirSync(STATE_DIR, { recursive: true });
}

// =============================================================================
// Types
// =============================================================================

interface Scar {
  id: string;           // P1, P2, etc.
  rule: string;         // The RULE line
  triggers: string[];   // Keywords that should trigger this scar
  origin: string;       // Where it came from
  level: string;        // consequence level

  // Phase 1: Full scar context (data-only, not yet used in matching)
  yin?: string;         // The specific mistake / wound
  yang?: string;        // The consequence / harm caused
  constraints?: string[]; // Repair rules derived from the scar
  remember?: string;    // Optional narrative / quote
}

/**
 * Phase 2: Advisory context returned with match results
 * This allows consumers to understand WHY the scar matters
 */
interface ScarAdvisory {
  wound?: string;        // The yin - what went wrong before
  consequence?: string;  // The yang - what harm it caused
  checks?: string[];     // The constraints - what to verify
  remember?: string;     // The narrative/quote to keep in mind
}

interface MatchResult {
  matched: boolean;
  scar?: Scar;
  relevance: number;  // 0-1
  reason: string;

  // Phase 2: Enriched advisory context (optional, only when matched)
  advisory?: ScarAdvisory;
}

interface DaemonState {
  scars: Scar[];
  lastLoaded: string;
  matchesTriggered: number;
  recentMatches: string[];  // Last 20 match reasons
}

// =============================================================================
// SCAR Parser - Extract from SOUL.md
// =============================================================================

function parseScars(content: string): Scar[] {
  const scars: Scar[] = [];

  // Split by principle headers (### P1, ### P2, etc.)
  const principleRegex = /### (P\d+): (.+?)(?:\n\n|$)/g;
  const fullPrinciples = content.split(/(?=### P\d+)/);

  for (const block of fullPrinciples) {
    if (!block.trim()) continue;

    // Extract principle ID and title
    const headerMatch = block.match(/### (P\d+): (.+)/);
    if (!headerMatch) continue;

    const id = headerMatch[1];
    const title = headerMatch[2];

    // Extract RULE
    const ruleMatch = block.match(/\*\*RULE:\*\* (.+?)(?:\n\n|\n\*\*|$)/s);
    if (!ruleMatch) continue;

    const rule = ruleMatch[1].trim();

    // Extract trigger keywords from the rule and title
    const triggers = extractTriggers(rule + ' ' + title, block);

    // Extract origin
    const originMatch = block.match(/\*\*ORIGIN:\*\* (.+)/);
    const origin = originMatch ? originMatch[1] : 'Unknown';

    // Extract consequence level
    const levelMatch = block.match(/\*\*CONSEQUENCE LEVEL:\*\* (.+)/);
    const level = levelMatch ? levelMatch[1] : 'Medium';

    // Phase 1: Extract full scar context (YIN/YANG/CONSTRAINTS/Remember)
    const yinMatch = block.match(/\*\*YIN — What I did:\*\*\s*([\s\S]*?)(?=\*\*YANG|\*\*ORIGIN|\*\*CONSEQUENCE|$)/);
    const yangMatch = block.match(/\*\*YANG — What (?:that |it )?caused:\*\*\s*([\s\S]*?)(?=\*\*ORIGIN|\*\*CONSEQUENCE|\*\*CONSTRAINTS|\*\*Remember|---|$)/);
    const constraintsMatch = block.match(/\*\*CONSTRAINTS:\*\*\s*([\s\S]*?)(?=\*\*Remember|---|###|$)/);
    const rememberMatch = block.match(/\*\*Remember:\*\*\s*> (.+)/);

    const yin = yinMatch ? yinMatch[1].trim() : undefined;
    const yang = yangMatch ? yangMatch[1].trim() : undefined;

    // Parse constraints as array (numbered list items)
    let constraints: string[] | undefined;
    if (constraintsMatch) {
      const constraintText = constraintsMatch[1];
      const constraintLines = constraintText.split('\n')
        .map(line => line.trim())
        .filter(line => /^\d+\./.test(line))  // Only numbered items
        .map(line => line.replace(/^\d+\.\s*/, '').trim());
      if (constraintLines.length > 0) {
        constraints = constraintLines;
      }
    }

    const remember = rememberMatch ? rememberMatch[1].trim() : undefined;

    scars.push({
      id,
      rule,
      triggers,
      origin,
      level,
      // Phase 1: Full context (optional fields)
      ...(yin && { yin }),
      ...(yang && { yang }),
      ...(constraints && { constraints }),
      ...(remember && { remember })
    });
  }

  return scars;
}

/**
 * Extract trigger keywords from principle content
 */
function extractTriggers(rule: string, fullBlock: string): string[] {
  const triggers: Set<string> = new Set();

  // Common action keywords
  const actionWords = [
    'move', 'rename', 'delete', 'remove', 'edit', 'modify', 'change',
    'read', 'check', 'verify', 'test', 'describe', 'claim', 'say',
    'search', 'find', 'assume', 'guess', 'fix', 'commit', 'push', 'pull',
    'folder', 'file', 'directory', 'path'
  ];

  // Extract words from rule
  const words = rule.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (word.length > 3 && actionWords.includes(word)) {
      triggers.add(word);
    }
  }

  // Special patterns from full block
  if (fullBlock.includes('hardcoded path')) triggers.add('path');
  if (fullBlock.includes('folder name')) triggers.add('folder');
  if (fullBlock.includes('file') && fullBlock.includes('timestamp')) triggers.add('timestamp');
  if (fullBlock.includes('verify') || fullBlock.includes('check')) triggers.add('verify');
  if (fullBlock.includes('substrate') || fullBlock.includes('hallucination')) triggers.add('substrate');
  if (fullBlock.includes('retrieval') || fullBlock.includes('search')) triggers.add('retrieval');
  if (fullBlock.includes('error') || fullBlock.includes('mistake')) triggers.add('error');
  if (fullBlock.includes('identity') || fullBlock.includes('github')) triggers.add('identity');

  return Array.from(triggers);
}

// =============================================================================
// SCAR Daemon Core
// =============================================================================

class SCARDaemon {
  private state: DaemonState;
  private scars: Scar[] = [];

  constructor() {
    this.state = this.loadState();
    this.scars = this.loadScars();
  }

  private loadState(): DaemonState {
    try {
      if (existsSync(STATE_FILE)) {
        return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch (e) {
      this.log('WARN', `Failed to load state: ${e}`);
    }

    return {
      scars: [],
      lastLoaded: '',
      matchesTriggered: 0,
      recentMatches: []
    };
  }

  private saveState(): void {
    try {
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      this.log('ERROR', `Failed to save state: ${e}`);
    }
  }

  private loadScars(): Scar[] {
    try {
      if (!existsSync(SCAR_FILE)) {
        this.log('ERROR', `SOUL.md not found at ${SCAR_FILE}`);
        return [];
      }

      const content = readFileSync(SCAR_FILE, 'utf-8');
      const scars = parseScars(content);

      this.log('INFO', `Loaded ${scars.length} scars from SOUL.md`);

      // Update state
      this.state.scars = scars;
      this.state.lastLoaded = new Date().toISOString();
      this.saveState();

      return scars;
    } catch (e) {
      this.log('ERROR', `Failed to load scars: ${e}`);
      return [];
    }
  }

  /**
   * Main matching function
   * Call this before taking action to check for relevant scars
   */
  match(context: string): MatchResult {
    const contextLower = context.toLowerCase();
    let bestMatch: { scar: Scar; score: number; reason: string } | null = null;

    for (const scar of this.scars) {
      let matchScore = 0;
      let matchedTriggers: string[] = [];

      for (const trigger of scar.triggers) {
        if (contextLower.includes(trigger.toLowerCase())) {
          matchScore += 0.3; // Each trigger match adds 0.3
          matchedTriggers.push(trigger);
        }
      }

      // Need at least 2 trigger matches or 1 strong match
      if (matchScore >= 0.6 && matchedTriggers.length >= 2) {
        const reason = `${scar.id}: "${matchedTriggers.join('", "')}" matched`;

        if (!bestMatch || matchScore > bestMatch.score) {
          bestMatch = {
            scar,
            score: matchScore,
            reason
          };
        }
      }
    }

    if (bestMatch) {
      // Record the match
      this.state.matchesTriggered++;
      this.state.recentMatches.unshift(bestMatch.reason);
      if (this.state.recentMatches.length > 20) {
        this.state.recentMatches.pop();
      }
      this.saveState();

      this.log('MATCH', bestMatch.reason);

      // Phase 2: Build advisory context from the matched scar
      const advisory: ScarAdvisory = {};
      if (bestMatch.scar.yin) advisory.wound = bestMatch.scar.yin;
      if (bestMatch.scar.yang) advisory.consequence = bestMatch.scar.yang;
      if (bestMatch.scar.constraints && bestMatch.scar.constraints.length > 0) {
        advisory.checks = bestMatch.scar.constraints;
      }
      if (bestMatch.scar.remember) advisory.remember = bestMatch.scar.remember;

      return {
        matched: true,
        scar: bestMatch.scar,
        relevance: bestMatch.score,
        reason: bestMatch.reason,
        // Only include advisory if we have any context to share
        ...(Object.keys(advisory).length > 0 && { advisory })
      };
    }

    return {
      matched: false,
      relevance: 0,
      reason: 'No scar matched'
    };
  }

  /**
   * Get all loaded scars
   */
  getScars(): Scar[] {
    return this.scars;
  }

  /**
   * Reload scars from SOUL.md
   */
  reload(): void {
    this.scars = this.loadScars();
  }

  /**
   * Get daemon status
   */
  getStatus(): { scarsLoaded: number; lastLoaded: string; matchesTriggered: number } {
    return {
      scarsLoaded: this.scars.length,
      lastLoaded: this.state.lastLoaded,
      matchesTriggered: this.state.matchesTriggered
    };
  }

  /**
   * Get recent matches
   */
  getRecentMatches(): string[] {
    return this.state.recentMatches;
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;

    try {
      writeFileSync(LOG_FILE, logLine, { flag: 'a' });
    } catch {}

    console.log(`[SCAR-DAEMON] [${level}] ${message}`);
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

const daemon = new SCARDaemon();

// =============================================================================
// CLI Entry Point
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          SCAR DAEMON - Living Conscience                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  switch (cmd) {
    case 'start':
    case 'run':
      console.log('Starting SCAR daemon...');
      const status = daemon.getStatus();
      console.log('');
      console.log(`  Scars loaded: ${status.scarsLoaded}`);
      console.log(`  Last loaded: ${status.lastLoaded || 'Never'}`);
      console.log(`  Matches triggered: ${status.matchesTriggered}`);
      console.log('');
      console.log('SCAR daemon is now watching.');
      console.log('Press Ctrl+C to stop.');
      console.log('');

      // Write heartbeat file
      const heartbeatFile = join(STATE_DIR, 'heartbeat');
      try {
        writeFileSync(heartbeatFile, new Date().toISOString());
        console.log('[SCAR] Heartbeat started');
      } catch (e) {
        console.error('[SCAR] Failed to write heartbeat:', e);
      }

      // Keep running with heartbeat
      const heartbeatInterval = setInterval(() => {
        try {
          writeFileSync(heartbeatFile, new Date().toISOString());
          // Only log every 12th heartbeat (once per minute)
        } catch (e) {
          console.error('[SCAR] Heartbeat error:', e);
        }
      }, 5000);

      // Periodic checkpoint (every 5 minutes)
      // This ensures SCAR advisories are captured even if user closes window without typing 'exit'
      const SESSION_FILE = join(__dirname, '../constitution/SESSION.md');
      const checkpointInterval = setInterval(() => {
        try {
          if (!existsSync(SESSION_FILE)) return;

          const content = readFileSync(SESSION_FILE, 'utf-8');

          // Extract EVENTS section (same logic as scar-session-checkpoint.ts)
          const eventsMatch = content.match(/## EVENTS[\s\S]*?(?=##|$)/);
          if (!eventsMatch) return;

          const eventsText = eventsMatch[0];
          if (eventsText.length < 100) return; // Skip if no meaningful content

          // Run SCAR match on events
          const result = daemon.match(eventsText);

          if (result.matched) {
            console.log(`[SCAR] Periodic checkpoint: ${result.scar.id} matched (${(result.relevance * 100).toFixed(0)}%)`);

            // Append advisory to SESSION.md if not duplicate
            const advisoryMarker = `<!-- SCAR_ADVISORY: ${result.scar.id}`;
            if (!content.includes(advisoryMarker)) {
              const advisorySection = `

---

## SCAR Advisory (Periodic Checkpoint)

**Generated:** ${new Date().toISOString()}

### ${result.scar.id} (${(result.relevance * 100).toFixed(0)}% relevance)

${result.advisory?.wound ? `**Wound:** ${result.advisory.wound.slice(0, 200)}...` : ''}
${result.advisory?.consequence ? `**Consequence:** ${result.advisory.consequence.slice(0, 200)}...` : ''}
${result.advisory?.checks ? `**Checks:**\n${result.advisory.checks.slice(0, 3).map(c => `- ${c.slice(0, 100)}`).join('\n')}` : ''}

> ${result.advisory?.remember || result.scar.rule.slice(0, 150)}...
`;

              writeFileSync(SESSION_FILE, content + advisorySection, 'utf-8');
              console.log('[SCAR] Advisory appended to SESSION.md');
            }
          }
        } catch (e) {
          console.error('[SCAR] Periodic checkpoint error:', e);
        }
      }, 5 * 60 * 1000); // Every 5 minutes

      console.log('[SCAR] Periodic checkpoint enabled (every 5 minutes)');

      // Handle shutdown gracefully
      process.on('SIGINT', () => {
        clearInterval(heartbeatInterval);
        clearInterval(checkpointInterval);
        console.log('[SCAR] Shutting down...');
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        clearInterval(heartbeatInterval);
        clearInterval(checkpointInterval);
        console.log('[SCAR] Shutting down...');
        process.exit(0);
      });

      // Keep process alive
      await new Promise(() => {});
      break;

    case 'match':
      const contextToMatch = args.slice(1).join(' ');
      if (!contextToMatch) {
        console.log('Usage: bun run scar-daemon.ts match "context to check"');
        break;
      }
      const result = daemon.match(contextToMatch);
      console.log('');
      if (result.matched) {
        console.log('⚠️  SCAR MATCHED:');
        console.log(`   ${result.scar.id}: ${result.scar.rule.slice(0, 60)}...`);
        console.log(`   Relevance: ${(result.relevance * 100).toFixed(0)}%`);
        console.log(`   Reason: ${result.reason}`);
      } else {
        console.log('✅ No scar matched');
      }
      break;

    case 'list':
      const scars = daemon.getScars();
      console.log('');
      console.log(`Loaded Scars (${scars.length}):`);
      for (const scar of scars) {
        console.log(`  ${scar.id}: ${scar.rule.slice(0, 50)}...`);
        console.log(`    Triggers: ${scar.triggers.slice(0, 5).join(', ')}`);
      }
      break;

    case 'status':
      const st = daemon.getStatus();
      console.log('');
      console.log('SCAR Daemon Status:');
      console.log(`  Scars loaded: ${st.scarsLoaded}`);
      console.log(`  Last loaded: ${st.lastLoaded || 'Never'}`);
      console.log(`  Matches triggered: ${st.matchesTriggered}`);
      break;

    case 'recent':
      const recent = daemon.getRecentMatches();
      console.log('');
      console.log('Recent Matches:');
      if (recent.length === 0) {
        console.log('  No matches yet');
      } else {
        for (const match of recent) {
          console.log(`  - ${match}`);
        }
      }
      break;

    case 'reload':
      daemon.reload();
      console.log('');
      console.log(`Reloaded ${daemon.getScars().length} scars from SOUL.md`);
      break;

    default:
      console.log('Commands:');
      console.log('  start       - Start daemon (runs forever)');
      console.log('  match "X"   - Check if context matches any scar');
      console.log('  list        - List all loaded scars');
      console.log('  status      - Show daemon status');
      console.log('  recent      - Show recent matches');
      console.log('  reload      - Reload scars from SOUL.md');
      console.log('');
      console.log('Examples:');
      console.log('  bun run scar-daemon.ts match "I want to delete this folder"');
      console.log('  bun run scar-daemon.ts match "verify the file exists"');
  }
}

// Run if called directly
if (import.meta.main) {
  main().catch(e => {
    console.error('[FATAL]', e);
    process.exit(1);
  });
}

// Export for programmatic use
export { daemon, SCARDaemon, type Scar, type ScarAdvisory, type MatchResult };
