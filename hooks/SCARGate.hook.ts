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
 * OUTPUT:
 * - { continue: true } - Tool proceeds
 * - { continue: false, reason: "..." } - Tool blocked
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

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
// Import SCAR daemon
// ========================================

// Dynamic import to get the daemon
async function getSCARDaemon() {
  try {
    const module = await import(SCAR_DAEMON_PATH);
    return module.daemon;
  } catch (e) {
    // SCAR daemon not available - fail OPEN
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

  // BUILD THE REASON
  const reason = `[SCAR BLOCKED] ${scar.id}: ${scar.rule.slice(0, 100)}...

Why blocked: ${scar.yang || 'This action matches a high-consequence principle'}

What to do instead:
${scar.constraints.slice(0, 3).map((c: string) => `• ${c.slice(0, 150)}`).join('\n')}

> ${scar.remember || 'Check before acting.'}

[Relevance: ${(relevance * 100).toFixed(0)}%]`;

  return { block: true, reason };
}

// ========================================
// Tool Classification
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
 * These commands don't modify the filesystem.
 */
const READ_ONLY_PATTERNS = [
  /^ls\b/, /^dir\b/, /^cat\b/, /^head\b/, /^tail\b/, /^less\b/, /^more\b/,
  /^grep\b/, /^rg\b/, /^find\b/, /^which\b/, /^whereis\b/, /^type\b/,
  /^echo\b/, /^printf\b/, /^pwd\b/, /^whoami\b/, /^id\b/, /^uname\b/,
  /^git status/, /^git log/, /^git diff/, /^git show/, /^git branch/,
  /^git remote/, /^git config/, /^gh\b/, /^curl\b/, /^wget\b/,
  /^stat\b/, /^file\b/, /^du\b/, /^df\b/, /^free\b/, /^ps\b/, /^top\b/
];

/**
 * Check if a tool operation is read-only.
 */
function isReadOnly(toolName: string, toolInput: any): boolean {
  // Check tool name against allowlist
  if (READ_ONLY_TOOLS.includes(toolName)) {
    return true;
  }

  // For Bash, check the command pattern
  if (toolName === 'Bash' && toolInput?.command) {
    const cmd = toolInput.command.trim();
    for (const pattern of READ_ONLY_PATTERNS) {
      if (pattern.test(cmd)) {
        return true;
      }
    }
  }

  return false;
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
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const { tool_name, tool_input } = data;

  // Allow read-only operations to pass through without SCAR blocking
  // SCAR protects against destructive actions, not information gathering
  if (isReadOnly(tool_name, tool_input)) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // Get SCAR daemon
  const daemon = await getSCARDaemon();
  if (!daemon) {
    // SCAR not available - fail OPEN
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // Build context for matching
  const context = buildContext(tool_name, tool_input);

  // Run SCAR match
  try {
    const result = daemon.match(context);

    // Check if we should block
    const { block, reason } = shouldBlock(result);

    if (block) {
      console.log(JSON.stringify({
        continue: false,
        reason: reason
      }));
      process.exit(0);
    }
  } catch (e) {
    // Match failed - fail OPEN
    console.error('[SCARGate] Match error:', e);
  }

  // Allow tool to proceed
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

main().catch(e => {
  // Never crash - fail OPEN
  console.error('[SCARGate] Error:', e);
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
