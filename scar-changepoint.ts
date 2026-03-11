#!/usr/bin/env bun
/**
 * SCAR Change Point Detection v2.0
 * Detects permanent preference shifts vs temporary exceptions
 * Part of Phase 2: Decision Intelligence
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SCAR_DIR = join(process.env.HOME!, ".claude/PAI/SCAR");
const BEHAVIOR_FILE = join(SCAR_DIR, "behavior_history.json");

interface BehaviorEvent {
  timestamp: string;
  pattern: string;
  action: string;
  outcome: "corrected" | "approved" | "blocked" | "override";
  context: Record<string, any>;
}

interface BehaviorHistory {
  events: BehaviorEvent[];
  lastCleanup: string;
}

interface ChangePointResult {
  isChangePoint: boolean;
  confidence: number;
  isPermanent: boolean;
  reason: string;
}

// Thresholds
const HAZARD_RATE = 0.1;
const MIN_EVENTS_FOR_DETECTION = 3;
const CONSISTENCY_THRESHOLD = 0.7;

/**
 * Record a behavior event
 */
export function recordBehavior(
  pattern: string,
  action: string,
  outcome: BehaviorEvent["outcome"],
  context: Record<string, any> = {}
): void {
  const history = loadHistory();

  history.events.push({
    timestamp: new Date().toISOString(),
    pattern,
    action,
    outcome,
    context,
  });

  // Keep last 500 events
  if (history.events.length > 500) {
    history.events = history.events.slice(-500);
  }

  // Cleanup old events monthly
  const lastCleanup = new Date(history.lastCleanup);
  const now = new Date();
  if (now.getMonth() !== lastCleanup.getMonth()) {
    history.lastCleanup = now.toISOString();
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    history.events = history.events.filter(e =>
      new Date(e.timestamp) > cutoff
    );
  }

  saveHistory(history);
}

/**
 * Detect if this is a change point (permanent shift vs temporary exception)
 */
export function detectChangePoint(
  pattern: string,
  context: Record<string, any> = {}
): ChangePointResult {
  const history = loadHistory();

  // Get events for this pattern
  const patternEvents = history.events.filter(e =>
    patternsMatch(e.pattern, pattern)
  );

  if (patternEvents.length < MIN_EVENTS_FOR_DETECTION) {
    return {
      isChangePoint: false,
      confidence: 0,
      isPermanent: false,
      reason: "Not enough history to determine",
    };
  }

  // Check consistency across contexts
  const contextGroups = groupByContext(patternEvents);
  const consistencyScore = calculateConsistency(contextGroups, context);

  // Check recent behavior trend
  const recentTrend = calculateRecentTrend(patternEvents);

  // Decision logic
  const isPermanent = consistencyScore > CONSISTENCY_THRESHOLD && recentTrend > 0.5;

  return {
    isChangePoint: consistencyScore > 0.5 || recentTrend > 0.7,
    confidence: Math.max(consistencyScore, recentTrend),
    isPermanent,
    reason: isPermanent
      ? "Behavior consistent across contexts - permanent shift"
      : "Behavior varies by context - likely temporary exception",
  };
}

/**
 * Check if two patterns match (fuzzy)
 */
function patternsMatch(p1: string, p2: string): boolean {
  const words1 = new Set(p1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(p2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  if (words1.size === 0 || words2.size === 0) return false;

  const intersection = [...words1].filter(w => words2.has(w));
  const minSize = Math.min(words1.size, words2.size);

  return intersection.length >= minSize * 0.5;
}

/**
 * Group events by context
 */
function groupByContext(events: BehaviorEvent[]): Map<string, BehaviorEvent[]> {
  const groups = new Map<string, BehaviorEvent[]>();

  for (const event of events) {
    const contextKey = event.context?.project || "general";
    if (!groups.has(contextKey)) {
      groups.set(contextKey, []);
    }
    groups.get(contextKey)!.push(event);
  }

  return groups;
}

/**
 * Calculate consistency score across contexts
 * High consistency = same outcome across different contexts = permanent
 */
function calculateConsistency(
  contextGroups: Map<string, BehaviorEvent[]>,
  currentContext: Record<string, any>
): number {
  if (contextGroups.size < 2) {
    return 0.5; // Can't determine with one context
  }

  // Get dominant outcome per context
  const dominantOutcomes: string[] = [];

  for (const events of contextGroups.values()) {
    const counts = new Map<string, number>();
    for (const e of events) {
      counts.set(e.outcome, (counts.get(e.outcome) || 0) + 1);
    }

    let maxOutcome = "";
    let maxCount = 0;
    for (const [outcome, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        maxOutcome = outcome;
      }
    }
    dominantOutcomes.push(maxOutcome);
  }

  // Calculate consistency
  const outcomeCounts = new Map<string, number>();
  for (const o of dominantOutcomes) {
    outcomeCounts.set(o, (outcomeCounts.get(o) || 0) + 1);
  }

  const maxConsistency = Math.max(...outcomeCounts.values());
  return maxConsistency / dominantOutcomes.length;
}

/**
 * Calculate recent trend (last 10 events)
 * Positive = more corrections recently = likely permanent shift
 */
function calculateRecentTrend(events: BehaviorEvent[]): number {
  const recent = events.slice(-10);
  if (recent.length === 0) return 0;

  const corrections = recent.filter(e => e.outcome === "corrected").length;
  const overrides = recent.filter(e => e.outcome === "override").length;

  // High corrections = user reinforcing = permanent
  // High overrides = user disagreeing = not permanent
  return (corrections - overrides) / recent.length;
}

/**
 * Load behavior history
 */
function loadHistory(): BehaviorHistory {
  if (!existsSync(BEHAVIOR_FILE)) {
    return { events: [], lastCleanup: new Date().toISOString() };
  }

  try {
    return JSON.parse(readFileSync(BEHAVIOR_FILE, "utf-8"));
  } catch {
    return { events: [], lastCleanup: new Date().toISOString() };
  }
}

/**
 * Save behavior history
 */
function saveHistory(history: BehaviorHistory): void {
  writeFileSync(BEHAVIOR_FILE, JSON.stringify(history, null, 2));
}

/**
 * Get statistics
 */
export function getStats(): { totalEvents: number; patterns: number; contexts: number } {
  const history = loadHistory();
  const patterns = new Set(history.events.map(e => e.pattern));
  const contexts = new Set(history.events.map(e => e.context?.project || "general"));

  return {
    totalEvents: history.events.length,
    patterns: patterns.size,
    contexts: contexts.size,
  };
}

/**
 * Get recent events for a pattern
 */
export function getRecentEvents(pattern: string, limit: number = 10): BehaviorEvent[] {
  const history = loadHistory();
  return history.events
    .filter(e => patternsMatch(e.pattern, pattern))
    .slice(-limit);
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);

  switch (args[0]) {
    case "stats":
      console.log(JSON.stringify(getStats(), null, 2));
      break;

    case "detect":
      if (args.length < 2) {
        console.log("Usage: scar-changepoint.ts detect <pattern>");
        process.exit(1);
      }
      const result = detectChangePoint(args[1]);
      console.log(JSON.stringify(result, null, 2));
      break;

    default:
      console.log("SCAR Change Point Detection v2.0");
      console.log("Commands:");
      console.log("  stats           - Show statistics");
      console.log("  detect <pattern> - Detect if pattern is change point");
  }
}

export { BehaviorEvent, ChangePointResult };
