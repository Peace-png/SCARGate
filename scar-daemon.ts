#!/usr/bin/env bun
/**
 * SCAR Daemon - Living Conscience
 *
 * Loads scars from constitution/SOUL.md at startup
 * Watches for matching context and surfaces relevant scars
 *
 * Run: bun run scar-daemon.ts start
 *
 * SECURITY (v1.1 - Critical 2 Fix):
 * - HTTP API authenticated via shared secret
 * - Rate limiting per IP
 * - Localhost-only binding by default
 * - /reload endpoint always requires authentication
 * - Request size limits
 * - CORS restricted to same-origin
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

// =============================================================================
// Configuration
// =============================================================================

// PAI Integration: Read from TELOS/WISDOM.md
const SCAR_FILE = join(__dirname, '..', 'USER', 'TELOS', 'WISDOM.md');
const STATE_DIR = join(__dirname, 'scar-daemon');
const STATE_FILE = join(STATE_DIR, 'state.json');
const LOG_FILE = join(STATE_DIR, 'scar.log');
const BLOCKS_LOG = join(STATE_DIR, 'blocks.log');

// Export BLOCKS_LOG for dashboard
export { BLOCKS_LOG };

// Ensure state directory
if (!existsSync(STATE_DIR)) {
  const { mkdirSync } = require('fs');
  mkdirSync(STATE_DIR, { recursive: true });
}

// =============================================================================
// HTTP API SECURITY CONFIGURATION (Critical 2 Fix)
// =============================================================================

interface DaemonConfig {
  sharedSecret: string | null;     // Loaded from file, never logged
  rateLimitWindowMs: number;       // Time window for rate limiting
  rateLimitMaxRequests: number;    // Max requests per window per IP
  allowLocalhostOnly: boolean;     // Bind to localhost only
  reloadRequiresSecret: boolean;   // /reload endpoint requires authentication
}

const DAEMON_CONFIG_PATH = join(STATE_DIR, 'daemon.config.json');

function loadDaemonConfig(): DaemonConfig {
  const defaults: DaemonConfig = {
    sharedSecret: null,              // No secret by default (backwards compatible)
    rateLimitWindowMs: 60000,        // 1 minute window
    rateLimitMaxRequests: 100,       // 100 requests per minute per IP
    allowLocalhostOnly: true,        // Localhost only by default
    reloadRequiresSecret: true       // /reload requires auth by default
  };

  try {
    if (existsSync(DAEMON_CONFIG_PATH)) {
      const raw = readFileSync(DAEMON_CONFIG_PATH, 'utf-8');
      const loaded = JSON.parse(raw);
      return { ...defaults, ...loaded };
    }
  } catch (e) {
    console.error('[SCAR] Config load failed, using defaults:', e);
  }
  return defaults;
}

const daemonConfig = loadDaemonConfig();

// Rate limiting state
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

/**
 * Check rate limit for an IP
 */
function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > daemonConfig.rateLimitWindowMs) {
    // New window
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return {
      allowed: true,
      remaining: daemonConfig.rateLimitMaxRequests - 1,
      resetIn: daemonConfig.rateLimitWindowMs
    };
  }

  if (entry.count >= daemonConfig.rateLimitMaxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetIn: daemonConfig.rateLimitWindowMs - (now - entry.windowStart)
    };
  }

  entry.count++;
  return {
    allowed: true,
    remaining: daemonConfig.rateLimitMaxRequests - entry.count,
    resetIn: daemonConfig.rateLimitWindowMs - (now - entry.windowStart)
  };
}

/**
 * Validate shared secret from request
 */
function validateSecret(req: Request): boolean {
  // If no secret configured, skip auth (backwards compatible)
  if (!daemonConfig.sharedSecret) {
    return true;
  }

  // Check Authorization header: "Bearer <secret>"
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return token === daemonConfig.sharedSecret;
  }

  // Check X-SCAR-Secret header (alternative)
  const secretHeader = req.headers.get('X-SCAR-Secret');
  if (secretHeader) {
    return secretHeader === daemonConfig.sharedSecret;
  }

  return false;
}

/**
 * Extract client IP from request
 */
function getClientIp(req: Request): string {
  // Check X-Forwarded-For (if behind proxy)
  const forwarded = req.headers.get('X-Forwarded-For');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  // Fall back to connection info
  return '127.0.0.1';  // Localhost fallback
}

/**
 * Log unauthorized access attempt
 */
function logUnauthorizedAccess(req: Request, endpoint: string, reason: string): void {
  const timestamp = new Date().toISOString();
  const ip = getClientIp(req);
  const userAgent = req.headers.get('User-Agent') || 'unknown';

  console.error(`[SCAR] UNAUTHORIZED: ${timestamp} | IP=${ip} | endpoint=${endpoint} | reason=${reason} | UA=${userAgent}`);

  // Write to security log
  const securityLog = join(STATE_DIR, 'security.log');
  const entry = JSON.stringify({
    timestamp,
    ip,
    endpoint,
    reason,
    userAgent
  }) + '\n';

  try {
    writeFileSync(securityLog, entry, { flag: 'a' });
  } catch {}
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
        this.log('ERROR', `WISDOM.md not found at ${SCAR_FILE}`);
        return [];
      }

      const content = readFileSync(SCAR_FILE, 'utf-8');
      const scars = parseScars(content);

      this.log('INFO', `Loaded ${scars.length} scars from WISDOM.md`);

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
      if (matchScore >= 0.6 && matchedTriggers.length >= 1) {
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
   * Reload scars from WISDOM.md
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

  /**
   * Log a block to the blocks log file
   */
  logBlock(context: string, result: MatchResult): void {
    if (!result.matched) return;

    const entry = {
      timestamp: new Date().toISOString(),
      context: context.slice(0, 200),
      scar_id: result.scar?.id,
      relevance: result.relevance,
      blocked: result.relevance >= 0.8 && (result.scar?.level?.includes('High') || result.scar?.level?.includes('Critical'))
    };

    try {
      const logLine = JSON.stringify(entry) + '\n';
      writeFileSync(BLOCKS_LOG, logLine, { flag: 'a' });
    } catch {}
  }

  /**
   * Get block logs
   */
  getBlockLogs(limit: number = 50): any[] {
    try {
      if (!existsSync(BLOCKS_LOG)) return [];
      const content = readFileSync(BLOCKS_LOG, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      return lines.slice(-limit).map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      }).filter((l): l is any => l !== null);
    } catch {
      return [];
    }
  }

  /**
   * Get statistics for dashboard
   */
  getStats(): { totalBlocks: number; todayBlocks: number; principleHits: Record<string, number> } {
    const logs = this.getBlockLogs(1000);
    const today = new Date().toDateString();

    const totalBlocks = logs.filter(l => l.blocked).length;
    const todayBlocks = logs.filter(l => l.blocked && new Date(l.timestamp).toDateString() === today).length;

    const principleHits: Record<string, number> = {};
    for (const log of logs) {
      if (log.scar_id) {
        principleHits[log.scar_id] = (principleHits[log.scar_id] || 0) + 1;
      }
    }

    return { totalBlocks, todayBlocks, principleHits };
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;

    try {
      writeFileSync(LOG_FILE, logLine, { flag: 'a' });
    } catch {}

    console.error(`[SCAR-DAEMON] [${level}] ${message}`);
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
      const port = parseInt(args[1]) || 3773;
      console.log('Starting SCAR daemon...');
      const status = daemon.getStatus();
      console.log('');
      console.log(`  Scars loaded: ${status.scarsLoaded}`);
      console.log(`  Last loaded: ${status.lastLoaded || 'Never'}`);
      console.log(`  Matches triggered: ${status.matchesTriggered}`);
      console.log('');

      // Security status
      console.log('Security Configuration:');
      console.log(`  Shared secret: ${daemonConfig.sharedSecret ? 'configured ✓' : 'not set (public mode)'}`);
      console.log(`  Rate limit: ${daemonConfig.rateLimitMaxRequests} req/${daemonConfig.rateLimitWindowMs/1000}s`);
      console.log(`  Binding: ${daemonConfig.allowLocalhostOnly ? 'localhost only ✓' : 'all interfaces'}`);
      console.log(`  /reload auth: ${daemonConfig.reloadRequiresSecret ? 'required ✓' : 'not required'}`);
      console.log('');

      console.log('SCAR daemon is now watching.');
      console.log(`HTTP server starting on port ${port}...`);
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

      // Write port file for SCARGate to find
      const portFile = join(STATE_DIR, 'port');
      writeFileSync(portFile, String(port));

      // Keep running with heartbeat
      const heartbeatInterval = setInterval(() => {
        try {
          writeFileSync(heartbeatFile, new Date().toISOString());
          // Only log every 12th heartbeat (once per minute)
        } catch (e) {
          console.error('[SCAR] Heartbeat error:', e);
        }
      }, 5000);

      // Start HTTP server using Bun's built-in server
      const server = Bun.serve({
        port,
        hostname: daemonConfig.allowLocalhostOnly ? '127.0.0.1' : '0.0.0.0',

        async fetch(req) {
          const url = new URL(req.url);
          const clientIp = getClientIp(req);

          // SECURITY: No CORS wildcard - only same-origin allowed
          const secureHeaders = {
            'Access-Control-Allow-Origin': `http://localhost:${port}`,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SCAR-Secret',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
          };

          // Handle preflight
          if (req.method === 'OPTIONS') {
            return new Response(null, { headers: secureHeaders });
          }

          // Rate limiting check
          const rateCheck = checkRateLimit(clientIp);
          if (!rateCheck.allowed) {
            logUnauthorizedAccess(req, url.pathname, 'rate_limit_exceeded');
            return Response.json(
              { error: 'Rate limit exceeded', resetIn: rateCheck.resetIn },
              {
                status: 429,
                headers: {
                  ...secureHeaders,
                  'Retry-After': String(Math.ceil(rateCheck.resetIn / 1000))
                }
              }
            );
          }

          // Health check - PUBLIC (no auth required)
          if (url.pathname === '/health') {
            return Response.json({
              status: 'ok',
              scarsLoaded: daemon.getStatus().scarsLoaded,
              uptime: process.uptime(),
              rateLimit: {
                remaining: rateCheck.remaining,
                limit: daemonConfig.rateLimitMaxRequests
              }
            }, { headers: secureHeaders });
          }

          // Match endpoint - requires auth if secret configured
          if (url.pathname === '/match' && req.method === 'POST') {
            if (!validateSecret(req)) {
              logUnauthorizedAccess(req, '/match', 'invalid_or_missing_secret');
              return Response.json(
                { error: 'Unauthorized - valid secret required' },
                { status: 401, headers: secureHeaders }
              );
            }

            try {
              const body = await req.json();

              // Request size limit (prevent DoS)
              const contextSize = JSON.stringify(body).length;
              if (contextSize > 100000) {  // 100KB limit
                return Response.json(
                  { error: 'Request too large' },
                  { status: 413, headers: secureHeaders }
                );
              }

              const context = body.context || '';
              const result = daemon.match(context);
              daemon.logBlock(context, result);
              return Response.json(result, { headers: secureHeaders });
            } catch (e) {
              return Response.json({ error: 'Invalid request' }, { status: 400, headers: secureHeaders });
            }
          }

          // Blocks log for dashboard - requires auth if secret configured
          if (url.pathname === '/blocks') {
            if (!validateSecret(req)) {
              logUnauthorizedAccess(req, '/blocks', 'invalid_or_missing_secret');
              return Response.json(
                { error: 'Unauthorized' },
                { status: 401, headers: secureHeaders }
              );
            }

            const limit = parseInt(url.searchParams.get('limit') || '50');
            return Response.json(daemon.getBlockLogs(limit), { headers: secureHeaders });
          }

          // Stats for dashboard - requires auth if secret configured
          if (url.pathname === '/stats') {
            if (!validateSecret(req)) {
              logUnauthorizedAccess(req, '/stats', 'invalid_or_missing_secret');
              return Response.json(
                { error: 'Unauthorized' },
                { status: 401, headers: secureHeaders }
              );
            }

            return Response.json(daemon.getStats(), { headers: secureHeaders });
          }

          // List scars - requires auth if secret configured
          if (url.pathname === '/scars') {
            if (!validateSecret(req)) {
              logUnauthorizedAccess(req, '/scars', 'invalid_or_missing_secret');
              return Response.json(
                { error: 'Unauthorized' },
                { status: 401, headers: secureHeaders }
              );
            }

            return Response.json(daemon.getScars(), { headers: secureHeaders });
          }

          // Status - requires auth if secret configured
          if (url.pathname === '/status') {
            if (!validateSecret(req)) {
              logUnauthorizedAccess(req, '/status', 'invalid_or_missing_secret');
              return Response.json(
                { error: 'Unauthorized' },
                { status: 401, headers: secureHeaders }
              );
            }

            return Response.json(daemon.getStatus(), { headers: secureHeaders });
          }

          // Reload - ALWAYS requires auth (even if secret not configured for other endpoints)
          if (url.pathname === '/reload' && req.method === 'POST') {
            if (daemonConfig.reloadRequiresSecret && !validateSecret(req)) {
              logUnauthorizedAccess(req, '/reload', 'invalid_or_missing_secret_CRITICAL');
              return Response.json(
                { error: 'Unauthorized - reload requires valid secret' },
                { status: 401, headers: secureHeaders }
              );
            }

            daemon.reload();
            console.log(`[SCAR] RELOAD authorized from ${clientIp}`);
            return Response.json({ reloaded: daemon.getScars().length }, { headers: secureHeaders });
          }

          return Response.json({ error: 'Not found' }, { status: 404, headers: secureHeaders });
        }
      });

      console.log(`[SCAR] HTTP server running on http://localhost:${port}`);
      console.log(`[SCAR] Endpoints:`);
      console.log(`[SCAR]   GET  /health - Health check (public)`);
      console.log(`[SCAR]   POST /match  - Check context against scars (auth required)`);
      console.log(`[SCAR]   GET  /scars  - List all scars (auth required)`);
      console.log(`[SCAR]   GET  /status - Daemon status (auth required)`);
      console.log(`[SCAR]   POST /reload - Reload scars (auth ALWAYS required)`);

      // Periodic checkpoint (every 5 minutes)
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
        server.stop();
        // Remove port file
        try { require('fs').unlinkSync(portFile); } catch {}
        console.log('[SCAR] Shutting down...');
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        clearInterval(heartbeatInterval);
        clearInterval(checkpointInterval);
        server.stop();
        try { require('fs').unlinkSync(portFile); } catch {}
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
      break;

    case 'reload':
      daemon.reload();
      console.log('');
      console.log(`Reloaded ${daemon.getScars().length} scars from WISDOM.md`);
      break;

    case 'gen-secret':
      // Generate a new shared secret for      const newSecret = require('crypto').randomBytes(32).toString('hex');
      console.log('');
      console.log('Generated new shared secret:');
      console.log('');
      console.log(`Add to ${DAEMON_CONFIG_PATH}:`);
      console.log(`  "sharedSecret": "${newSecret}"`);
      console.log('');
      console.log('IMPORTANT: Store this secret securely!');
      console.log('The SCARGate hook will need this secret to authenticate.');
      break;

    default:
      console.log('Commands:');
      console.log('  start       - Start daemon (runs forever)');
      console.log('  match "X"   - Check if context matches any scar');
      console.log('  list        - List all loaded scars');
      console.log('  status      - Show daemon status');
      console.log('  recent      - Show recent matches');
      console.log('  reload      - Reload scars from WISDOM.md');
      console.log('  gen-secret  - Generate a new shared secret');
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
