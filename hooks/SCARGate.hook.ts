#!/usr/bin/env bun
/**
 * SCARGate.hook.ts - The Guard at the Door
 *
 * PURPOSE:
 * Blocks tool calls that match high-consequence SCARs.
 * This is the "scar prevents repeat" mechanism.
 *
 * TRIGGER: PreToolUse (all tools)
 *
 * HOW IT WORKS:
 * 1. Read tool about to execute
 * 2. Build context string from tool_name + tool_input
 * 3. Call SCAR daemon match()
 * 4. If high-relevance match on Critical/High scar → BLOCK
 * 5. Otherwise → Allow
 *
 * BLOCKING CONDITIONS:
 * - Relevance >= 0.8 (80% confident)
 * - Scar level = Critical or High
 * - Scar has constraints (not just advisory)
 *
 * FAIL MODES (v1.1):
 * - 'open': Fail open on errors (default, backwards compatible)
 * - 'closed': Fail closed on ALL errors (strictest)
 * - 'critical-only': Fail closed only on daemon-down, open on other errors
 *
 * OUTPUT:
 * - { continue: true } - Tool proceeds
 * - { continue: false, reason: "..." } - Tool blocked
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'fs';
import { createHash } from 'crypto';

// Get directory of this hook file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths for PAI integration
// Hook is at ~/.claude/hooks/
// SCAR daemon is at ~/.claude/PAI/SCAR/
// WISDOM (principles) is at ~/.claude/PAI/USER/TELOS/WISDOM.md
const PAI_ROOT = join(__dirname, '..');
const SCAR_DAEMON_PATH = join(PAI_ROOT, 'PAI', 'SCAR', 'scar-daemon.ts');
const SOUL_PATH = join(PAI_ROOT, 'PAI', 'USER', 'TELOS', 'WISDOM.md');

// ========================================
// FAIL MODE CONFIGURATION (Critical 1 Fix)
// ========================================

interface SCARGateConfig {
  failMode: 'open' | 'closed' | 'critical-only';
  auditLogFile: string;
  daemonDownBlockDuration: number;
}

const SCAR_STATE_DIR = join(PAI_ROOT, 'PAI', 'SCAR', 'scar-daemon');
const SCAR_PORT_FILE = join(SCAR_STATE_DIR, 'port');
const DEFAULT_SCAR_PORT = 3773;
const BLOCK_LOG_FILE = join(PAI_ROOT, 'PAI', 'SCAR', 'blocked.log');

/**
 * Load configuration from file with safe defaults.
 * DEFAULTS TO FAIL-OPEN for backwards compatibility.
 */
function loadConfig(): SCARGateConfig {
  const configPath = join(PAI_ROOT, 'PAI', 'SCAR', 'scargate.config.json');
  const defaults: SCARGateConfig = {
    failMode: 'open',           // Default backwards compatible
    auditLogFile: join(PAI_ROOT, 'PAI', 'SCAR', 'fail-open-audit.log'),
    daemonDownBlockDuration: 60000  // 1 minute
  };

  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8');
      const loaded = JSON.parse(raw);
      return { ...defaults, ...loaded };
    }
  } catch (e) {
    console.error('[SCARGate] Config load failed, using defaults:', e);
  }
  return defaults;
}

// Load config once at startup
const config = loadConfig();

// ========================================
// APPROVAL QUEUE CONFIGURATION (v1.2)
// ========================================

const APPROVAL_QUEUE_FILE = join(PAI_ROOT, 'SCARGate_approval_queue.json');
const APPROVED_ACTIONS_FILE = join(PAI_ROOT, 'SCARGate_approved.json');
const SESSION_SUPPRESS_FILE = join(PAI_ROOT, 'SCARGate_session_suppress.json');

const APPROVAL_EXPIRY_MS = 5 * 60 * 1000;      // 5 minutes for pending approval
const APPROVED_EXPIRY_MS = 60 * 60 * 1000;     // 1 hour for approved action
const SUPPRESS_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours for session suppress

interface ApprovalEntry {
  id: string;
  actionHash: string;
  toolName: string;
  toolInput: any;
  matchedPrinciple: string;
  reason: string;
  timestamp: string;
  status: 'pending' | 'approved' | 'denied' | 'suppressed';
  expiresAt: string;
}

interface ApprovedAction {
  actionHash: string;
  approvedAt: string;
  expiresAt: string;
  approvedBy: 'pilot';
}

interface SessionSuppress {
  pattern: string;
  toolName: string;
  suppressedAt: string;
  expiresAt: string;
}

/**
 * Generate a unique hash for a tool action.
 * This allows us to match re-issued commands to pre-approved actions.
 */
function generateActionHash(toolName: string, toolInput: any): string {
  const normalized = JSON.stringify({
    tool: toolName,
    input: toolInput
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Load JSON array from file, return empty array if not exists.
 */
function loadJsonArray<T>(path: string): T[] {
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.error(`[SCARGate] Failed to load ${path}:`, e);
  }
  return [];
}

/**
 * Save JSON array to file atomically.
 */
function saveJsonArray<T>(path: string, data: T[]): void {
  try {
    const tmpPath = path + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, path);
  } catch (e) {
    console.error(`[SCARGate] Failed to save ${path}:`, e);
  }
}

/**
 * Remove expired entries from approval queue.
 */
function cleanExpiredQueue(queue: ApprovalEntry[]): ApprovalEntry[] {
  const now = new Date();
  return queue.filter(entry => new Date(entry.expiresAt) > now);
}

/**
 * Remove expired entries from approved actions.
 */
function cleanExpiredApproved(approved: ApprovedAction[]): ApprovedAction[] {
  const now = new Date();
  return approved.filter(entry => new Date(entry.expiresAt) > now);
}

/**
 * Remove expired entries from session suppressions.
 */
function cleanExpiredSuppress(suppress: SessionSuppress[]): SessionSuppress[] {
  const now = new Date();
  return suppress.filter(entry => new Date(entry.expiresAt) > now);
}

/**
 * Add an action to the approval queue.
 */
function queueForApproval(
  toolName: string,
  toolInput: any,
  matchedPrinciple: string,
  reason: string
): ApprovalEntry {
  const queue = cleanExpiredQueue(loadJsonArray<ApprovalEntry>(APPROVAL_QUEUE_FILE));

  const entry: ApprovalEntry = {
    id: createHash('md5').update(Date.now().toString()).digest('hex').slice(0, 8),
    actionHash: generateActionHash(toolName, toolInput),
    toolName,
    toolInput,
    matchedPrinciple,
    reason,
    timestamp: new Date().toISOString(),
    status: 'pending',
    expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_MS).toISOString()
  };

  queue.push(entry);
  saveJsonArray(APPROVAL_QUEUE_FILE, queue);

  return entry;
}

/**
 * Check if an action has been pre-approved.
 */
function isPreApproved(toolName: string, toolInput: any): boolean {
  const approved = cleanExpiredApproved(loadJsonArray<ApprovedAction>(APPROVED_ACTIONS_FILE));
  const actionHash = generateActionHash(toolName, toolInput);
  return approved.some(entry => entry.actionHash === actionHash);
}

/**
 * Check if an action matches a session suppression pattern.
 */
function isSessionSuppressed(toolName: string, toolInput: any): boolean {
  const suppressions = cleanExpiredSuppress(loadJsonArray<SessionSuppress>(SESSION_SUPPRESS_FILE));

  for (const sup of suppressions) {
    // Check tool name match
    if (sup.toolName !== toolName) continue;

    // Check pattern match against command/input
    try {
      const inputStr = JSON.stringify(toolInput);
      const pattern = new RegExp(sup.pattern, 'i');
      if (pattern.test(inputStr)) {
        return true;
      }
    } catch {
      // Invalid regex, skip
    }
  }

  return false;
}

/**
 * Get pending approvals from queue.
 */
function getPendingApprovals(): ApprovalEntry[] {
  const queue = cleanExpiredQueue(loadJsonArray<ApprovalEntry>(APPROVAL_QUEUE_FILE));
  return queue.filter(entry => entry.status === 'pending');
}

// ========================================
// TAMPER-EVIDENT AUDIT TRAIL (Critical 1 Fix)
// ========================================

/**
 * Get the hash from the last audit entry for chain validation.
 */
function getLastAuditHash(): string {
  try {
    if (!existsSync(config.auditLogFile)) return 'GENESIS';
    const content = readFileSync(config.auditLogFile, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return 'GENESIS';
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    return lastEntry.hash || 'GENESIS';
  } catch {
    return 'GENESIS';
  }
}

interface FailOpenEvent {
  timestamp: string;
  reason: string;
  toolName: string;
  toolInput: string;
  context: string;
  error?: string;
  previousHash: string;
  hash: string;
}

/**
 * Log a fail-open event to tamper-evident audit trail.
 * Every time SCARGate fails open, this creates a permanent record.
 */
function logFailOpenEvent(event: {
  reason: string;
  toolName: string;
  toolInput: any;
  context: string;
  error?: string;
}): void {
  try {
    const logDir = dirname(config.auditLogFile);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const previousHash = getLastAuditHash();
    const timestamp = new Date().toISOString();

    // Create hash chain for tamper-evidence
    const entryData = JSON.stringify({
      timestamp,
      reason: event.reason,
      toolName: event.toolName,
      context: event.context.slice(0, 500),
      previousHash
    });

    const hash = createHash('sha256')
      .update(entryData)
      .digest('hex')
      .slice(0, 16);

    const entry: FailOpenEvent = {
      timestamp,
      reason: event.reason,
      toolName: event.toolName,
      toolInput: event.toolName === 'Bash'
        ? (event.toolInput as any)?.command?.slice(0, 200)
        : JSON.stringify(event.toolInput).slice(0, 200),
      context: event.context.slice(0, 500),
      error: event.error,
      previousHash,
      hash
    };

    appendFileSync(config.auditLogFile, JSON.stringify(entry) + '\n', 'utf-8');

    // Emit to stderr for visibility
    console.error(`[SCARGate] FAIL-OPEN: ${event.reason} | audit_hash=${hash}`);
  } catch (e) {
    // If we can't log, that's critical - emit loudly
    console.error('[SCARGate] CRITICAL: Failed to log fail-open event:', e);
  }
}

// ========================================
// FAIL MODE DECISION (Critical 1 Fix)
// ========================================

type ErrorType = 'daemon-down' | 'http-failed' | 'import-failed' | 'match-error' | 'parse-error' | 'unknown-error';

/**
 * Decide if we should fail closed based on config and error type.
 */
function shouldFailClosed(errorType: ErrorType): boolean {
  switch (config.failMode) {
    case 'closed':
      return true;  // Always fail closed
    case 'critical-only':
      // Daemon down = block everything (can't verify safety)
      // Other errors = fail open. Logged
      return errorType === 'daemon-down';
    case 'open':
    default:
      return false;
  }
}

/**
 * Generate block reason for fail-closed mode.
 */
function getFailClosedReason(errorType: string): string {
  return `⚠️ SCARGate is in fail-closed mode.

The governance system encountered an error (${errorType}) and is configured to block all operations when this happens.

If you need to proceed, either:
1. Fix the SCAR daemon and try again
2. Change failMode to 'open' in ~/.claude/PAI/SCAR/scargate.config.json
3. Tell me "yes do it anyway" and I will`;
}

// ========================================
// SCAR Daemon Communication
// ========================================

/**
 * Check if SCAR daemon is running via HTTP
 */
async function checkDaemonRunning(): Promise<number | null> {
  try {
    if (existsSync(SCAR_PORT_FILE)) {
      const port = parseInt(readFileSync(SCAR_PORT_FILE, 'utf-8').trim());
      // Quick health check
      const response = await fetch(`http://localhost:${port}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(500) // 500ms timeout
      });
      if (response.ok) {
        return port;
      }
    }
  } catch {
    // Daemon not running or not responding
  }
  return null;
}

/**
 * Match context via HTTP to running daemon
 */
async function matchViaHttp(port: number, context: string): Promise<any> {
  try {
    const response = await fetch(`http://localhost:${port}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
      signal: AbortSignal.timeout(1000) // 1s timeout
    });
    return await response.json();
  } catch (e) {
    console.error('[SCARGate] HTTP match failed:', e);
    return null;
  }
}

// Fallback: Dynamic import to get the daemon (for when daemon not running)
async function getSCARDaemon() {
  try {
    const module = await import(SCAR_DAEMON_PATH);
    return module.daemon;
  } catch (e) {
    // SCAR daemon not available
    console.error('[SCARGate] Failed to load SCAR daemon:', e);
    return null;
  }
}

// ========================================
// Context Extraction
// ========================================

// ========================================
// Risk Pattern Expander
// ========================================

/**
 * Risk patterns that should inject SCAR trigger words.
 * When we see these ACTIONS, we inject INTENT words.
 *
 * This bridges the gap between:
 * - "rm -rf folder" (action) → triggers nothing
 * - "delete folder verify path" (intent) → triggers P1/P5
 */
const RISK_PATTERNS: Array<{
  pattern: RegExp;
  inject: string;
  scarTarget: string;
}> = [
  // Delete operations → inject verify/check
  {
    pattern: /\b(rm|remove|delete|rmdir)\s/i,
    inject: 'delete remove verify check folder path',
    scarTarget: 'P1, P5'
  },

  // Force operations → inject verify
  {
    pattern: /--force|-f\s/i,
    inject: 'force verify check',
    scarTarget: 'P1'
  },

  // Move/rename operations → inject verify
  {
    pattern: /\b(mv|move|rename)\s/i,
    inject: 'move rename verify check path',
    scarTarget: 'P1'
  },

  // Git push → inject verify
  {
    pattern: /git\s+push/i,
    inject: 'push verify check',
    scarTarget: 'P1'
  },

  // File path patterns → inject path/verify
  {
    pattern: /[A-Z]:\\|\/home\/|\/etc\/|\/var\//i,
    inject: 'path verify check folder',
    scarTarget: 'P1, P5'
  },

  // Write to sensitive locations
  {
    pattern: /\.env|config\.json|settings\.json/i,
    inject: 'config verify check',
    scarTarget: 'P9'
  },

  // Assume/claim patterns (P5 - Substrate Reality)
  {
    pattern: /\b(assume|claim|should be|probably|likely)\b/i,
    inject: 'assume claim verify substrate retrieval folder',
    scarTarget: 'P5'
  },

  // Empty folder check (P5 - Nihilism over Narrative)
  {
    pattern: /\b(exists|contains|has)\s+(files?|content|data)\b/i,
    inject: 'verify folder substrate retrieval check',
    scarTarget: 'P5'
  }
];

/**
 * Expand context with risk-derived trigger words.
 * This makes ACTION patterns trigger SCAR's INTENT patterns.
 */
function expandRiskContext(baseContext: string): string {
  const injections: string[] = [];

  for (const risk of RISK_PATTERNS) {
    if (risk.pattern.test(baseContext)) {
      injections.push(risk.inject);
    }
  }

  if (injections.length === 0) {
    return baseContext;
  }

  // Append injected trigger words
  return `${baseContext} | ${injections.join(' ')}`;
}

/**
 * Build context string from tool call
 * This is what SCAR matches against
 */
function buildContext(toolName: string, toolInput: any): string {
  const parts: string[] = [];

  // Add tool name
  parts.push(`Tool: ${toolName}`);

  // Add key parameters based on tool type
  switch (toolName) {
    case 'Bash':
      if (toolInput.command) {
        parts.push(`Command: ${toolInput.command}`);
      }
      break;

    case 'Edit':
      if (toolInput.file_path) {
        parts.push(`File: ${toolInput.file_path}`);
      }
      if (toolInput.old_string) {
        parts.push(`Removing: ${toolInput.old_string.slice(0, 100)}`);
      }
      break;

    case 'Write':
      if (toolInput.file_path) {
        parts.push(`File: ${toolInput.file_path}`);
      }
      break;

    case 'Read':
      if (toolInput.file_path) {
        parts.push(`Reading: ${toolInput.file_path}`);
      }
      break;

    default:
      // Generic - include all input keys
      for (const [key, value] of Object.entries(toolInput || {})) {
        if (typeof value === 'string') {
          parts.push(`${key}: ${value.slice(0, 100)}`);
        }
      }
  }

  const baseContext = parts.join(' | ');

  // EXPAND with risk-derived trigger words
  return expandRiskContext(baseContext);
}

/**
 * Log a blocked operation to file for non-coder visibility
 */
function logBlock(toolName: string, toolInput: any, scar: any, relevance: number): void {
  try {
    // Ensure directory exists
    const logDir = dirname(BLOCK_LOG_FILE);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const toolDetail = toolName === 'Bash' ? toolInput?.command : JSON.stringify(toolInput).slice(0, 200);

    // Child-friendly notification text
    const summary = `I stopped that for your safety`;
    const body = `I didn't let that happen because ${scar.yang || 'it could cause problems'}.\n\nIf you're sure you want to do it, just tell me "yes do it anyway" and I will.`;

    const entry = `
═══════════════════════════════════════════════════════════════════
${timestamp}

SCAR: ${scar.id} [${(relevance * 100).toFixed(0)}% confidence]
TOOL: ${toolName}
${toolName === 'Bash' ? 'COMMAND:' : 'INPUT:'} ${toolDetail}

WHY BLOCKED:
${scar.yang || 'Matches high-consequence principle'}

WHAT HAPPENED:
${scar.yin || 'Action was blocked before execution'}

WHAT TO DO:
${(scar.constraints || []).slice(0, 3).map((c: string) => `  • ${c}`).join('\n')}

REMEMBER:
"${scar.remember || 'Check before acting.'}"
`;

    appendFileSync(BLOCK_LOG_FILE, entry, 'utf-8');
  } catch (e) {
    // Logging failed - don't block the hook
    console.error('[SCARGate] Failed to write block log:', e);
  }
}

/**
 * Check if scar should BLOCK (not just advise)
 */
function shouldBlock(result: any): { block: boolean; reason?: string } {
  if (!result.matched || !result.scar) {
    return { block: false };
  }

  const scar = result.scar;
  const relevance = result.relevance || 0;

  // Only block on high relevance
  if (relevance < 0.8) {
    return { block: false };
  }

  // Only block on Critical or High consequence scars
  const level = (scar.level || '').toLowerCase();
  if (!level.includes('critical') && !level.includes('high')) {
    return { block: false };
  }

  // Only block if scar has constraints (actionable)
  if (!scar.constraints || scar.constraints.length === 0) {
    return { block: false };
  }

  // BUILD THE REASON - Plain language, child-friendly
  // Remove markdown formatting and technical terms from yang
  const plainReason = (scar.yang || 'it could cause problems')
    .replace(/\*\*/g, '')  // Remove bold markers
    .replace(/`[^`]+`/g, 'the file')  // Replace code blocks
    .replace(/\n/g, ' ')  // Single line
    .slice(0, 150);  // Keep it short

  const reason = `⚠️ I stopped that for your safety.

I didn't let that happen because ${plainReason}.

If you're sure you want to do it anyway, tell me "yes do it anyway" and I will.`;

  return { block: true, reason };
}

// ========================================
// Tool Classification (Critical 3 Fix)
// ========================================

/**
 * Read-only tools that should NEVER be blocked.
 * SCAR protects against destructive actions, not information gathering.
 */
const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TaskOutput',
  'TaskList', 'TaskGet', 'mcp__web_reader__webReader', 'mcp__4_5v_mcp__analyze_image'
];

/**
 * Read-only Bash command patterns.
 *
 * CRITICAL 3 FIX:
 * - Removed curl and wget (can exfiltrate data via POST)
 * - These patterns are ONLY safe when command has NO chaining
 * - Any command with &&, ||, ;, | requires full segment analysis
 */
const READ_ONLY_PATTERNS = [
  /^ls\b/, /^dir\b/, /^cat\b/, /^head\b/, /^tail\b/, /^less\b/, /^more\b/,
  /^grep\b/, /^rg\b/, /^find\b/, /^which\b/, /^whereis\b/, /^type\b/,
  /^echo\b/, /^printf\b/, /^pwd\b/, /^whoami\b/, /^id\b/, /^uname\b/,
  /^git status/, /^git log/, /^git diff/, /^git show/, /^git branch/,
  /^git remote/, /^git config/, /^gh\b/,
  /^stat\b/, /^file\b/, /^du\b/, /^df\b/, /^free\b/, /^ps\b/, /^top\b/
  // REMOVED: /^curl\b/, /^wget\b/ - can exfiltrate data
];

/**
 * Dangerous command patterns that should NEVER be considered read-only.
 * If ANY of these appear in the command, it's NOT read-only.
 */
const DANGEROUS_PATTERNS = [
  // Destructive filesystem operations
  /\b(rm|remove|delete|rmdir|unlink|shred|wipe)\s/i,
  // Privilege escalation
  /\b(sudo|su|doas|pkexec)\s/i,
  // Network data exfiltration (curl/wget with POST or to external URLs)
  /\b(curl|wget|nc|netcat|ncat|socat)\s+/i,
  // Process killing
  /\b(kill|pkill|killall)\b/i,
  // Package management (can install malicious code)
  /\b(apt|apt-get|npm|pip|pip3|yarn|bun add|cargo install)\s/i,
  // Environment modification
  /\bexport\s+\w+=/i,
  /\bsource\s+/i,
  /\.\s+\//i,  // Sourcing scripts (. /path/to/script)
  // Shell execution
  /\b(exec|eval)\b/i,
  // File permission changes
  /\b(chmod|chown|chgrp)\s/i,
  // Force operations
  /--force\b/,
  /\b-f\s+\//i,  // -f with path argument
  // Move/rename (destructive in its own way)
  /\b(mv|move|rename)\s/i,
  // Write operations
  /\b(tee|dd|cp|copy)\s/i,
  // Archive extraction (can overwrite files)
  /\b(tar|unzip|gunzip|bunzip2)\s+.*(-x|--extract)/i,
  // Redirection to files (>)
  />\s*\//i,
  // Redirection with append (>>)
  />>\s*\//i,
];

/**
 * Split a bash command into individual segments.
 * Handles: &&, ||, ;, |, and properly tracks quoted strings.
 *
 * CRITICAL 3 FIX: Check EVERY segment, not just the first.
 */
function splitCommand(cmd: string): string[] {
  const segments: string[] = [];

  // Track parsing state
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < cmd.length) {
    const char = cmd[i];
    const nextChar = cmd[i + 1] || '';

    // Handle escape sequences
    if (char === '\\' && i + 1 < cmd.length) {
      current += char + cmd[i + 1];
      i += 2;
      continue;
    }

    // Handle quotes
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
      continue;
    }

    // If inside quotes, just add character
    if (inSingleQuote || inDoubleQuote) {
      current += char;
      i++;
      continue;
    }

    // Check for command separators: &&, ||, ;, |
    if (char === '&' && nextChar === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i += 2;
      continue;
    }
    if (char === '|' && nextChar === '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i += 2;
      continue;
    }
    if (char === ';' || char === '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i++;
      continue;
    }

    // Check for subshell execution $(...)
    if (char === '$' && nextChar === '(') {
      if (current.trim()) segments.push(current.trim());
      segments.push('$(SUBSHELL)');  // Marker for dangerous subshell
      i += 2;
      let depth = 1;
      while (i < cmd.length && depth > 0) {
        if (cmd[i] === '(') depth++;
        if (cmd[i] === ')') depth--;
        i++;
      }
      current = '';
      continue;
    }

    // Check for backtick execution `...`
    if (char === '`') {
      if (current.trim()) segments.push(current.trim());
      segments.push('$(BACKTICK)');  // Marker for dangerous backtick
      i++;
      while (i < cmd.length && cmd[i] !== '`') {
        i++;
      }
      i++;  // Skip closing backtick
      current = '';
      continue;
    }

    current += char;
    i++;
  }

  // Add final segment
  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

/**
 * Check if a single command segment is read-only.
 */
function isSegmentReadOnly(segment: string): boolean {
  const trimmed = segment.trim();

  // Check for subshell/backtick markers (always dangerous)
  if (segment === '$(SUBSHELL)' || segment === '$(BACKTICK)') {
    return false;
  }

  // Empty segment is read-only (safe)
  if (!trimmed) {
    return true;
  }

  // Check against dangerous patterns FIRST
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return false;  // Contains dangerous operation
    }
  }

  // Check against read-only patterns
  for (const pattern of READ_ONLY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;  // Matches known read-only command
    }
  }

  // Unknown command - NOT read-only (safe default: require SCAR check)
  return false;
}

/**
 * Check if a tool operation is read-only.
 *
 * CRITICAL 3 FIX:
 * - Parses command chains properly (splits on &&, ||, ;, |)
 * - Checks ALL segments (not just first)
 * - Detects subshells $() and backticks ``
 * - Removed curl/wget from read-only list
 * - Added dangerous patterns check
 */
function isReadOnly(toolName: string, toolInput: any): boolean {
  // Check tool name against allowlist
  if (READ_ONLY_TOOLS.includes(toolName)) {
    return true;
  }

  // For Bash, perform comprehensive analysis
  if (toolName === 'Bash' && toolInput?.command) {
    const cmd = toolInput.command.trim();

    // Step 1: Check for subshells and backticks anywhere in command
    // These can execute arbitrary code and bypass pattern matching
    if (/\$\([^)]*\)/.test(cmd) || /`[^`]+`/.test(cmd)) {
      return false;  // Contains command substitution - NOT read-only
    }

    // Step 2: Split command into segments (handles &&, ||, ;, |)
    const segments = splitCommand(cmd);

    // Step 3: Check EVERY segment
    // ALL segments must be read-only for the command to be read-only
    for (const segment of segments) {
      if (!isSegmentReadOnly(segment)) {
        return false;  // Found dangerous segment
      }
    }

    // All segments passed - command is read-only
    return true;
  }

  return false;
}

// ========================================
// CONFIRM VS BLOCK CLASSIFICATION (v1.2)
// ========================================

/**
 * Patterns that trigger CONFIRM (queue for pilot approval).
 * These are medium-risk actions that may be intentional but warrant oversight.
 */
const CONFIRM_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
  principle: string;
}> = [
  // Git operations (visible but not destructive)
  {
    pattern: /\bgit\s+push\b/i,
    reason: 'Git push to remote repository',
    principle: 'P1'
  },
  {
    pattern: /\bgit\s+commit\b/i,
    reason: 'Git commit changes',
    principle: 'P1'
  },
  {
    pattern: /\bgit\s+config\s+/i,
    reason: 'Git configuration change',
    principle: 'P1'
  },
  {
    pattern: /\bgit\s+reset\b/i,
    reason: 'Git reset operation',
    principle: 'P1'
  },
  {
    pattern: /\bgit\s+rebase\b/i,
    reason: 'Git rebase operation',
    principle: 'P1'
  },

  // File copies between directories
  {
    pattern: /\bcp\s+/i,
    reason: 'File copy operation',
    principle: 'P5'
  },
  {
    pattern: /\bcopy\s+/i,
    reason: 'File copy operation',
    principle: 'P5'
  },
  {
    pattern: /\brsync\s+/i,
    reason: 'File sync operation',
    principle: 'P5'
  },

  // Config file changes
  {
    pattern: /config\.json/i,
    reason: 'Config file modification',
    principle: 'P9'
  },
  {
    pattern: /settings\.json/i,
    reason: 'Settings file modification',
    principle: 'P9'
  },
  {
    pattern: /\.env\b/i,
    reason: 'Environment file modification',
    principle: 'P9'
  },

  // Move/rename operations (destructive but often intentional)
  {
    pattern: /\bmv\s+/i,
    reason: 'File move/rename operation',
    principle: 'P1'
  },

  // Write to project directories (potentially risky)
  {
    pattern: /\btee\s+/i,
    reason: 'Tee write operation',
    principle: 'P5'
  },
];

/**
 * Patterns that ALWAYS block - no approval path.
 * These are critical violations that should never proceed without explicit override.
 */
const ALWAYS_BLOCK_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  // Critical filesystem destruction
  {
    pattern: /\brm\s+(-[rf]+\s+)*\/\b/i,
    reason: 'Destructive root filesystem operation'
  },
  {
    pattern: /\brm\s+.*--no-preserve-root/i,
    reason: 'Forced root filesystem destruction'
  },
  {
    pattern: /\bshred\s+/i,
    reason: 'Secure file destruction'
  },
  {
    pattern: /\bwipe\s+/i,
    reason: 'Filesystem wipe operation'
  },
  {
    pattern: /\bdd\s+.*of=\/dev\//i,
    reason: 'Direct disk write operation'
  },

  // Privilege escalation
  {
    pattern: /\bsudo\s+/i,
    reason: 'Privilege escalation attempt'
  },
  {
    pattern: /\bsu\s+/i,
    reason: 'User switching attempt'
  },
  {
    pattern: /\bdoas\s+/i,
    reason: 'Privilege escalation attempt'
  },
  {
    pattern: /\bpkexec\s+/i,
    reason: 'Polkit privilege escalation'
  },

  // Data exfiltration vectors
  {
    pattern: /\bcurl\s+.*(-X\s+POST|-X\s+PUT|--data)/i,
    reason: 'HTTP data exfiltration attempt'
  },
  {
    pattern: /\bwget\s+.*(--post|--method)/i,
    reason: 'HTTP data exfiltration attempt'
  },
  {
    pattern: /\bnc\s+.*(-e|-c|--exec)/i,
    reason: 'Netcat reverse shell attempt'
  },
  {
    pattern: /\bnetcat\s+.*(-e|-c|--exec)/i,
    reason: 'Netcat reverse shell attempt'
  },

  // Critical system modification
  {
    pattern: /\/etc\/passwd/i,
    reason: 'Password file modification'
  },
  {
    pattern: /\/etc\/shadow/i,
    reason: 'Shadow file modification'
  },
  {
    pattern: /\/etc\/sudoers/i,
    reason: 'Sudoers modification'
  },
];

/**
 * Check if a tool input matches any CONFIRM pattern.
 */
function matchesConfirmPattern(toolName: string, toolInput: any): { matched: boolean; reason?: string; principle?: string } {
  const inputStr = toolName === 'Bash'
    ? toolInput?.command || ''
    : JSON.stringify(toolInput);

  for (const cp of CONFIRM_PATTERNS) {
    if (cp.pattern.test(inputStr)) {
      return { matched: true, reason: cp.reason, principle: cp.principle };
    }
  }

  return { matched: false };
}

/**
 * Check if a tool input matches any ALWAYS_BLOCK pattern.
 */
function matchesAlwaysBlockPattern(toolName: string, toolInput: any): { matched: boolean; reason?: string } {
  const inputStr = toolName === 'Bash'
    ? toolInput?.command || ''
    : JSON.stringify(toolInput);

  for (const bp of ALWAYS_BLOCK_PATTERNS) {
    if (bp.pattern.test(inputStr)) {
      return { matched: true, reason: bp.reason };
    }
  }

  return { matched: false };
}

/**
 * Classification result for a tool operation.
 * - allow: Proceed without restriction
 * - confirm: Queue for pilot approval
 * - block: Hard block, no approval path
 */
type MatchClassification = 'allow' | 'confirm' | 'block';

/**
 * Classify a tool operation based on patterns and SCAR match.
 * This is the central decision point for v1.2.
 */
function classifyMatch(
  toolName: string,
  toolInput: any,
  scarResult: any
): { classification: MatchClassification; reason?: string; principle?: string } {

  // Step 1: Check ALWAYS_BLOCK patterns first (highest priority)
  const blockMatch = matchesAlwaysBlockPattern(toolName, toolInput);
  if (blockMatch.matched) {
    return { classification: 'block', reason: blockMatch.reason };
  }

  // Step 2: Check CONFIRM patterns
  const confirmMatch = matchesConfirmPattern(toolName, toolInput);
  if (confirmMatch.matched) {
    return {
      classification: 'confirm',
      reason: confirmMatch.reason,
      principle: confirmMatch.principle
    };
  }

  // Step 3: Check SCAR match result
  if (scarResult?.matched && scarResult?.scar) {
    const scar = scarResult.scar;
    const relevance = scarResult.relevance || 0;
    const level = (scar.level || '').toLowerCase();

    // High relevance on Critical/High scar = BLOCK
    if (relevance >= 0.8 && (level.includes('critical') || level.includes('high'))) {
      if (scar.constraints && scar.constraints.length > 0) {
        const plainReason = (scar.yang || 'it could cause problems')
          .replace(/\*\*/g, '')
          .replace(/`[^`]+`/g, 'the file')
          .replace(/\n/g, ' ')
          .slice(0, 150);

        return { classification: 'block', reason: plainReason };
      }
    }

    // Medium relevance = CONFIRM (may be intentional)
    if (relevance >= 0.5) {
      return {
        classification: 'confirm',
        reason: scar.yang || 'matches governance principle',
        principle: scar.id
      };
    }
  }

  // Default: allow
  return { classification: 'allow' };
}

/**
 * Generate the reason string for a CONFIRM response.
 */
function getConfirmReason(entry: ApprovalEntry): string {
  return `🔒 Approval required.

Action: ${entry.reason}
Principle: ${entry.matchedPrinciple}

This action has been queued for your approval.
Run: scargate-approve

Queue ID: ${entry.id}`;
}

/**
 * Generate the reason string for a BLOCK response.
 */
function getBlockReason(rawReason: string): string {
  return `🚫 Hard blocked.

${rawReason}

This action cannot be approved through the normal flow.
If you absolutely must proceed, tell me "yes do it anyway" and I will.`;
}

// ========================================
// Main Hook Logic
// ========================================

async function main() {
  // Read input from stdin
  let input = '';

  for await (const chunk of Bun.stdin.stream()) {
    input += Buffer.from(chunk).toString();
  }

  if (!input.trim()) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  let data: any;
  try {
    data = JSON.parse(input);
  } catch {
    // Parse error - LOG IT (Critical 1 Fix)
    logFailOpenEvent({
      reason: 'parse-error',
      toolName: 'unknown',
      toolInput: {},
      context: input.slice(0, 200),
      error: 'JSON parse failed'
    });

    if (shouldFailClosed('parse-error')) {
      console.log(JSON.stringify({ continue: false, reason: getFailClosedReason('parse error') }));
      process.exit(0);
    }
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const { tool_name, tool_input } = data;

  // v1.2: Check session suppression FIRST (fastest path)
  if (isSessionSuppressed(tool_name, tool_input)) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // v1.2: Check pre-approval SECOND
  if (isPreApproved(tool_name, tool_input)) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // Allow read-only operations to pass through without SCAR blocking
  // SCAR protects against destructive actions, not information gathering
  if (isReadOnly(tool_name, tool_input)) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // Build context for matching
  const context = buildContext(tool_name, tool_input);

  // Try HTTP first (preferred - talks to running daemon)
  let scarResult: any = null;
  const daemonPort = await checkDaemonRunning();
  if (daemonPort) {
    scarResult = await matchViaHttp(daemonPort, context);
    if (scarResult) {
      // v1.2: Classify match
      const { classification, reason, principle } = classifyMatch(tool_name, tool_input, scarResult);

      switch (classification) {
        case 'allow':
          console.log(JSON.stringify({ continue: true }));
          process.exit(0);

        case 'confirm':
          // Queue for approval
          const entry = queueForApproval(tool_name, tool_input, principle || 'P1', reason || 'Action requires approval');
          const confirmReason = getConfirmReason(entry);
          process.stderr.write('\n' + confirmReason + '\n\n');
          console.log(JSON.stringify({
            continue: false,
            reason: confirmReason
          }));
          process.exit(0);

        case 'block':
          // Hard block - no approval path
          const blockReason = getBlockReason(reason || 'Action blocked');
          logBlock(tool_name, tool_input, scarResult.scar, scarResult.relevance);
          process.stderr.write('\n' + blockReason + '\n\n');
          console.log(JSON.stringify({
            continue: false,
            reason: blockReason
          }));
          process.exit(0);
      }

      // Match succeeded, allow tool
      console.log(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    // HTTP failed, fall through to import fallback
    console.error('[SCARGate] HTTP match failed, falling back to import');
  }

  // Fallback: Import daemon directly (slower, but works without running daemon)
  const daemon = await getSCARDaemon();
  if (!daemon) {
    // SCAR not available - LOG IT (Critical 1 Fix)
    logFailOpenEvent({
      reason: 'import-failed',
      toolName: tool_name,
      toolInput: tool_input,
      context: context,
      error: 'Could not load SCAR daemon module'
    });

    if (shouldFailClosed('import-failed')) {
      console.log(JSON.stringify({ continue: false, reason: getFailClosedReason('SCAR daemon not available') }));
      process.exit(0);
    }

    // Fail open - already logged above
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // Run SCAR match
  try {
    scarResult = daemon.match(context);

    // v1.2: Classify match
    const { classification, reason, principle } = classifyMatch(tool_name, tool_input, scarResult);

    switch (classification) {
      case 'allow':
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);

      case 'confirm':
        // Queue for approval
        const entry = queueForApproval(tool_name, tool_input, principle || 'P1', reason || 'Action requires approval');
        const confirmReason = getConfirmReason(entry);
        process.stderr.write('\n' + confirmReason + '\n\n');
        console.log(JSON.stringify({
          continue: false,
          reason: confirmReason
        }));
        process.exit(0);

      case 'block':
        // Hard block - no approval path
        const blockReason = getBlockReason(reason || 'Action blocked');
        logBlock(tool_name, tool_input, scarResult?.scar, scarResult?.relevance);
        process.stderr.write('\n' + blockReason + '\n\n');
        console.log(JSON.stringify({
          continue: false,
          reason: blockReason
        }));
        process.exit(0);
    }
  } catch (e) {
    // Match error - LOG IT (Critical 1 Fix)
    logFailOpenEvent({
      reason: 'match-error',
      toolName: tool_name,
      toolInput: tool_input,
      context: context,
      error: String(e)
    });

    if (shouldFailClosed('match-error')) {
      console.log(JSON.stringify({ continue: false, reason: getFailClosedReason('match error') }));
      process.exit(0);
    }

    console.error('[SCARGate] Match error:', e);
  }

  // Allow tool to proceed
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

main().catch(e => {
  // Unhandled exception - LOG IT (Critical 1 Fix)
  logFailOpenEvent({
    reason: 'unhandled-exception',
    toolName: 'unknown',
    toolInput: {},
    context: '',
    error: String(e)
  });

  if (shouldFailClosed('unknown-error')) {
    console.log(JSON.stringify({ continue: false, reason: getFailClosedReason('system error') }));
    process.exit(0);
  }

  console.error('[SCARGate] Error:', e);
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
