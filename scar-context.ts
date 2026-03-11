#!/usr/bin/env bun
/**
 * SCAR Context Analyzer v2.0
 * Extracts and maintains context for smarter decisions
 * Part of Phase 2: Decision Intelligence
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SCAR_DIR = join(process.env.HOME!, ".claude/PAI/SCAR");
const CONTEXT_FILE = join(SCAR_DIR, "session_context.json");

interface SessionContext {
  currentProject: string | null;
  currentTask: string | null;
  recentFiles: string[];
  recentActions: string[];
  taskType: "coding" | "research" | "debugging" | "deploying" | "general";
  lastUpdate: string;
}

// Task type indicators
const TASK_INDICATORS: Record<string, string[]> = {
  debugging: ["debug", "error", "fix", "bug", "trace", "console.log", "issue", "exception", "stack trace"],
  researching: ["research", "find", "search", "investigate", "look up", "docs", "documentation", "explore"],
  deploying: ["deploy", "push origin", "release", "ship", "production", "ci/cd", "publish", "docker push"],
  coding: ["implement", "build", "create", "write", "refactor", "add", "update", "edit", "feature"],
};

/**
 * Get current session context
 */
export function getContext(): SessionContext {
  if (!existsSync(CONTEXT_FILE)) {
    return getDefaultContext();
  }

  try {
    return JSON.parse(readFileSync(CONTEXT_FILE, "utf-8"));
  } catch {
    return getDefaultContext();
  }
}

/**
 * Update context from an action
 */
export function updateContext(
  action: string,
  toolName: string,
  toolInput: any
): SessionContext {
  const context = getContext();

  // Extract project
  const project = extractProject(action, toolInput);
  if (project) {
    context.currentProject = project;
  }

  // Extract task type
  const taskType = detectTaskType(action);
  if (taskType !== "general") {
    context.taskType = taskType;
  }

  // Track recent files
  const file = extractFile(toolInput);
  if (file) {
    context.recentFiles = [file, ...context.recentFiles.filter(f => f !== file).slice(0, 9)];
  }

  // Track recent actions (keep last 20)
  context.recentActions = [action.slice(0, 100), ...context.recentActions.slice(0, 19)];

  context.lastUpdate = new Date().toISOString();

  saveContext(context);
  return context;
}

/**
 * Extract project from action
 */
function extractProject(action: string, toolInput: any): string | null {
  // From file path
  if (toolInput?.file_path) {
    const match = (toolInput.file_path as string).match(/\/home\/[^/]+\/([^/]+)/);
    if (match) return match[1];
  }

  // From command cd
  const cdMatch = action.match(/cd\s+~\/([^/\s;&&|]+)/);
  if (cdMatch) return cdMatch[1];

  // From command with full path
  const pathMatch = action.match(/\/home\/[^/]+\/([^/]+)/);
  if (pathMatch) return pathMatch[1];

  // From git command
  const gitMatch = action.match(/git\s+.*--repo\s+\S*\/([^\/\s]+)/);
  if (gitMatch) return gitMatch[1];

  return null;
}

/**
 * Detect task type from action
 */
function detectTaskType(action: string): SessionContext["taskType"] {
  const lower = action.toLowerCase();

  for (const [type, indicators] of Object.entries(TASK_INDICATORS)) {
    if (indicators.some(ind => lower.includes(ind))) {
      return type as SessionContext["taskType"];
    }
  }

  return "general";
}

/**
 * Extract file from tool input
 */
function extractFile(toolInput: any): string | null {
  if (toolInput?.file_path) {
    return toolInput.file_path as string;
  }
  if (toolInput?.path) {
    return toolInput.path as string;
  }
  return null;
}

/**
 * Save context to file
 */
function saveContext(context: SessionContext): void {
  writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));
}

/**
 * Get default context
 */
function getDefaultContext(): SessionContext {
  return {
    currentProject: null,
    currentTask: null,
    recentFiles: [],
    recentActions: [],
    taskType: "general",
    lastUpdate: new Date().toISOString(),
  };
}

/**
 * Check if action is during active task
 * Used for timing decisions (don't interrupt during active work)
 */
export function isDuringActiveTask(): boolean {
  const context = getContext();
  const lastUpdate = new Date(context.lastUpdate);
  const now = new Date();
  const minutesSinceUpdate = (now.getTime() - lastUpdate.getTime()) / (1000 * 60);

  // If updated in last 5 minutes, user is actively working
  return minutesSinceUpdate < 5;
}

/**
 * Get context summary for decision making
 */
export function getContextSummary(): Record<string, any> {
  const context = getContext();
  return {
    project: context.currentProject,
    taskType: context.taskType,
    recentFileCount: context.recentFiles.length,
    isActive: isDuringActiveTask(),
  };
}

/**
 * Check if action matches current task context
 * Higher confidence if action is related to what user is doing
 */
export function actionMatchesContext(action: string): boolean {
  const context = getContext();

  // Check if action involves recent files
  for (const file of context.recentFiles.slice(0, 5)) {
    if (action.includes(file)) {
      return true;
    }
  }

  // Check if action involves current project
  if (context.currentProject && action.includes(context.currentProject)) {
    return true;
  }

  return false;
}

/**
 * Clear context (start fresh session)
 */
export function clearContext(): void {
  saveContext(getDefaultContext());
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);

  switch (args[0]) {
    case "show":
      console.log(JSON.stringify(getContext(), null, 2));
      break;

    case "summary":
      console.log(JSON.stringify(getContextSummary(), null, 2));
      break;

    case "clear":
      clearContext();
      console.log("Context cleared");
      break;

    default:
      console.log("SCAR Context Analyzer v2.0");
      console.log("");
      console.log("Commands:");
      console.log("  show    - Show full session context");
      console.log("  summary - Show context summary");
      console.log("  clear   - Clear context (fresh session)");
  }
}

export { SessionContext };
