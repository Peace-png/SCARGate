#!/usr/bin/env bun
/**
 * SCAR Hook v2.0
 * Integrates with Claude Code PreToolUse hook
 * Uses the learning system instead of approval queue
 */

import { decide, Decision } from "./scar-decide";
import { recordCorrection, overrideSCAR } from "./scar-learn";
import * as fs from "fs";
import * as path from "path";

const SCAR_DIR = path.join(process.env.HOME!, ".claude/PAI/SCAR");
const BLOCKED_LOG = path.join(SCAR_DIR, "blocked.log");

interface HookInput {
  tool_name: string;
  tool_input: any;
  session_id?: string;
}

interface HookOutput {
  decision: "approve" | "deny" | "undefined";
  message?: string;
}

/**
 * Main hook entry point
 */
async function main() {
  // Read hook input from stdin
  const input: HookInput = await readStdin();

  if (!input.tool_name || !input.tool_input) {
    output({ decision: "approve" });
    return;
  }

  // Build action string from tool call
  const action = buildActionString(input.tool_name, input.tool_input);
  const context = buildContext(input);

  // Get decision from SCAR engine
  const decision = decide(action, context);

  // Handle each outcome
  switch (decision.outcome) {
    case "allow":
      output({ decision: "approve" });
      break;

    case "log":
      // Allow but log
      output({ decision: "approve" });
      break;

    case "block":
      // Block and log
      logBlocked(action, decision);
      output({
        decision: "deny",
        message: decision.message || "Blocked by SCAR",
      });
      break;

    case "ask":
      // For now, allow but log that we should have asked
      // In future, this could integrate with approval system
      logBlocked(action, decision);
      output({
        decision: "approve", // Allow for now, but logged
        message: `[SCAR Note] ${decision.message}`,
      });
      break;
  }
}

/**
 * Build action string from tool call
 */
function buildActionString(toolName: string, toolInput: any): string {
  switch (toolName) {
    case "Bash":
      return toolInput.command || "bash command";

    case "Edit":
      return `edit ${toolInput.file_path || "file"}`;

    case "Write":
      return `write ${toolInput.file_path || "file"}`;

    case "Read":
      return `read ${toolInput.file_path || "file"}`;

    case "Glob":
      return `glob ${toolInput.pattern || "pattern"}`;

    case "Grep":
      return `grep ${toolInput.pattern || "pattern"}`;

    default:
      return `${toolName} ${JSON.stringify(toolInput).slice(0, 100)}`;
  }
}

/**
 * Build context from hook input
 */
function buildContext(input: HookInput): Record<string, any> {
  const context: Record<string, any> = {
    tool: input.tool_name,
  };

  // Extract project from file paths
  if (input.tool_input?.file_path) {
    const filePath = input.tool_input.file_path as string;
    const homeMatch = filePath.match(/\/home\/[^/]+\/([^/]+)/);
    if (homeMatch) {
      context.project = homeMatch[1];
    }
  }

  // Extract from working directory if available
  if (input.tool_input?.cwd) {
    const cwd = input.tool_input.cwd as string;
    const homeMatch = cwd.match(/\/home\/[^/]+\/([^/]+)/);
    if (homeMatch) {
      context.project = homeMatch[1];
    }
  }

  // Extract from command
  if (input.tool_name === "Bash" && input.tool_input?.command) {
    const cmd = input.tool_input.command as string;

    // Look for cd commands
    const cdMatch = cmd.match(/cd\s+([^\s;&&|]+)/);
    if (cdMatch) {
      const dir = cdMatch[1].replace(/^~/, process.env.HOME || "");
      const homeMatch = dir.match(/\/home\/[^/]+\/([^/]+)/);
      if (homeMatch) {
        context.project = homeMatch[1];
      }
    }

    // Look for file paths in command
    const pathMatch = cmd.match(/\/home\/[^/]+\/([^/]+)/);
    if (pathMatch && !context.project) {
      context.project = pathMatch[1];
    }
  }

  return context;
}

/**
 * Log blocked action to file
 */
function logBlocked(action: string, decision: Decision): void {
  // Ensure directory exists
  if (!fs.existsSync(SCAR_DIR)) {
    fs.mkdirSync(SCAR_DIR, { recursive: true });
  }

  const entry = {
    timestamp: new Date().toISOString(),
    action,
    outcome: decision.outcome,
    confidence: decision.confidence,
    uncertainty: decision.uncertainty,
    reason: decision.reason,
    message: decision.message,
    scarMatch: decision.scarMatch?.scarId,
    pattern: decision.scarMatch?.pattern,
  };

  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(BLOCKED_LOG, line);
}

/**
 * Read stdin as JSON
 */
async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const input = Buffer.concat(chunks).toString("utf-8");

  if (!input.trim()) {
    return { tool_name: "", tool_input: {} };
  }

  try {
    return JSON.parse(input);
  } catch {
    return { tool_name: "", tool_input: {} };
  }
}

/**
 * Output result to Claude Code
 */
function output(result: HookOutput): void {
  console.log(JSON.stringify(result));
}

// Run main
main().catch(err => {
  console.error("SCAR hook error:", err);
  output({ decision: "approve" }); // Fail open - safety first, but usability matters
});
