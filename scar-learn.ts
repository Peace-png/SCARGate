#!/usr/bin/env bun
/**
 * SCAR Learning Engine v2.0
 * Handles: recording corrections, updating confidence, adaptive forgetting
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as crypto from "crypto";

const SCAR_DIR = join(process.env.HOME!, ".claude/PAI/SCAR");
const LONG_TERM_FILE = join(SCAR_DIR, "scars_long_term.json");
const SESSION_FILE = join(SCAR_DIR, "scars_session.json");
const PROFILE_FILE = join(SCAR_DIR, "user_profile.json");
const LOG_FILE = join(SCAR_DIR, "action_log.json");

// Types
interface Example {
  bad: string;
  good: string;
}

interface SCAR {
  id: string;
  pattern: string;
  correction: string;
  examples: Example[];
  confidence: number;
  uncertainty: number;
  timesTriggered: number;
  timesCorrected: number;
  decayRate: number;
  stabilityScore: number;
  contexts: string[];
  createdAt: string;
  lastTriggered: string;
}

interface SessionSCAR {
  id: string;
  parentId: string | null;
  pattern: string;
  context: Record<string, any>;
  override: string;
  confidence: number;
  expiresAt: string;
  triggerCount: number;
  reverted: boolean;
  createdAt: string;
}

interface UserProfile {
  userId: string;
  stabilityScore: number;
  adaptiveDecayRate: number;
  totalCorrections: number;
  averageSessionLength: number;
  preferredContexts: string[];
  createdAt: string;
}

interface ActionLog {
  version: string;
  entries: ActionLogEntry[];
}

interface ActionLogEntry {
  id: string;
  timestamp: string;
  action: string;
  context: Record<string, any>;
  scarMatch: string | null;
  confidence: number;
  uncertainty: number;
  outcome: "auto_blocked" | "logged" | "asked" | "allowed";
  userReview: string | null;
}

interface LongTermData {
  version: string;
  scars: SCAR[];
}

interface SessionData {
  version: string;
  scars: SessionSCAR[];
}

// Load/Save helpers
function loadJSON<T>(path: string, defaultVal: T): T {
  if (!existsSync(path)) return defaultVal;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return defaultVal;
  }
}

function saveJSON<T>(path: string, data: T): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// Generate unique ID
function generateId(prefix: string = "scar"): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Record a new correction from user
 * This is called when user says "next time do X"
 */
export function recordCorrection(
  pattern: string,
  correction: string,
  context: Record<string, any> = {},
  isPermanent: boolean = true
): SCAR | SessionSCAR {
  const longTerm = loadJSON<LongTermData>(LONG_TERM_FILE, { version: "2.0", scars: [] });
  const session = loadJSON<SessionData>(SESSION_FILE, { version: "2.0", scars: [] });
  const profile = loadJSON<UserProfile>(PROFILE_FILE, getDefaultProfile());

  // Check if similar SCAR already exists
  const existing = findSimilarSCAR(pattern, longTerm.scars);

  if (existing && isPermanent) {
    // Update existing SCAR - user reinforced this lesson
    existing.correction = correction;
    existing.confidence = Math.min(existing.confidence + 0.20, 0.99);
    existing.uncertainty = Math.max(existing.uncertainty - 0.10, 0.01);
    existing.timesCorrected++;
    existing.lastTriggered = new Date().toISOString();

    // Adjust decay rate based on user stability
    existing.decayRate = profile.adaptiveDecayRate;

    saveJSON(LONG_TERM_FILE, longTerm);
    return existing;
  }

  // Create new SCAR
  const now = new Date().toISOString();
  const contextName = context?.project || "general";

  if (isPermanent) {
    const newSCAR: SCAR = {
      id: generateId("scar"),
      pattern,
      correction,
      examples: [],
      confidence: 0.70, // Start with medium confidence
      uncertainty: 0.30,
      timesTriggered: 1,
      timesCorrected: 1,
      decayRate: profile.adaptiveDecayRate,
      stabilityScore: profile.stabilityScore,
      contexts: [contextName],
      createdAt: now,
      lastTriggered: now,
    };

    longTerm.scars.push(newSCAR);
    saveJSON(LONG_TERM_FILE, longTerm);

    // Update profile
    profile.totalCorrections++;
    updateProfileStability(profile);
    saveJSON(PROFILE_FILE, profile);

    return newSCAR;
  } else {
    // Session SCAR - contextual exception
    const sessionSCAR: SessionSCAR = {
      id: generateId("session"),
      parentId: existing?.id || null,
      pattern,
      context,
      override: correction,
      confidence: 0.60,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      triggerCount: 1,
      reverted: false,
      createdAt: now,
    };

    session.scars.push(sessionSCAR);
    saveJSON(SESSION_FILE, session);

    return sessionSCAR;
  }
}

/**
 * Find similar SCAR by pattern similarity
 */
function findSimilarSCAR(pattern: string, scars: SCAR[]): SCAR | null {
  const patternLower = pattern.toLowerCase();
  const patternWords = patternLower.split(/\s+/);

  for (const scar of scars) {
    const scarLower = scar.pattern.toLowerCase();

    // Exact substring match
    if (scarLower.includes(patternLower) || patternLower.includes(scarLower)) {
      return scar;
    }

    // Word overlap match (at least 50% words match)
    const scarWords = scarLower.split(/\s+/);
    const overlap = patternWords.filter(w => scarWords.includes(w));
    if (overlap.length >= Math.min(patternWords.length, scarWords.length) * 0.5) {
      return scar;
    }
  }

  return null;
}

/**
 * Update user stability score based on correction patterns
 */
function updateProfileStability(profile: UserProfile): void {
  // If user corrects frequently, they're less stable (preferences change more)
  // If user rarely corrects, they're more stable
  const recentCorrections = profile.totalCorrections;

  if (recentCorrections > 20) {
    // High correction rate = volatile preferences
    profile.stabilityScore = Math.max(0.3, profile.stabilityScore - 0.05);
    profile.adaptiveDecayRate = Math.min(0.1, profile.adaptiveDecayRate + 0.01);
  } else if (recentCorrections < 5) {
    // Low correction rate = stable preferences
    profile.stabilityScore = Math.min(0.95, profile.stabilityScore + 0.02);
    profile.adaptiveDecayRate = Math.max(0.01, profile.adaptiveDecayRate - 0.005);
  }
}

/**
 * Log an action for the dashboard
 */
export function logAction(
  action: string,
  context: Record<string, any>,
  scarMatch: string | null,
  confidence: number,
  uncertainty: number,
  outcome: ActionLogEntry["outcome"]
): void {
  const log = loadJSON<ActionLog>(LOG_FILE, { version: "2.0", entries: [] });

  const entry: ActionLogEntry = {
    id: generateId("log"),
    timestamp: new Date().toISOString(),
    action,
    context,
    scarMatch,
    confidence,
    uncertainty,
    outcome,
    userReview: null,
  };

  log.entries.push(entry);

  // Keep last 1000 entries
  if (log.entries.length > 1000) {
    log.entries = log.entries.slice(-1000);
  }

  saveJSON(LOG_FILE, log);
}

/**
 * Update SCAR when triggered
 */
export function triggerSCAR(scarId: string): void {
  const longTerm = loadJSON<LongTermData>(LONG_TERM_FILE, { version: "2.0", scars: [] });

  const scar = longTerm.scars.find(s => s.id === scarId);
  if (scar) {
    scar.timesTriggered++;

    // Small confidence boost for each trigger without complaint
    // This is how the system learns that the rule is correct
    scar.confidence = Math.min(scar.confidence + 0.02, 0.99);
    scar.uncertainty = Math.max(scar.uncertainty - 0.01, 0.01);
    scar.lastTriggered = new Date().toISOString();

    saveJSON(LONG_TERM_FILE, longTerm);
  }
}

/**
 * User overrode a block - decrease confidence
 */
export function overrideSCAR(scarId: string, reason?: string): void {
  const longTerm = loadJSON<LongTermData>(LONG_TERM_FILE, { version: "2.0", scars: [] });

  const scar = longTerm.scars.find(s => s.id === scarId);
  if (scar) {
    scar.confidence = Math.max(scar.confidence - 0.15, 0.10);
    scar.uncertainty = Math.min(scar.uncertainty + 0.20, 0.90);

    saveJSON(LONG_TERM_FILE, longTerm);

    // Log the override
    logAction(
      "override",
      { reason },
      scarId,
      scar.confidence,
      scar.uncertainty,
      "allowed"
    );
  }
}

/**
 * Get default user profile
 */
function getDefaultProfile(): UserProfile {
  return {
    userId: "peace",
    stabilityScore: 0.75,
    adaptiveDecayRate: 0.03,
    totalCorrections: 0,
    averageSessionLength: 45,
    preferredContexts: ["coding", "research"],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Initialize SCAR system files if they don't exist
 */
export function initialize(): void {
  if (!existsSync(SCAR_DIR)) {
    require("fs").mkdirSync(SCAR_DIR, { recursive: true });
  }

  if (!existsSync(LONG_TERM_FILE)) {
    saveJSON(LONG_TERM_FILE, { version: "2.0", scars: [] });
  }

  if (!existsSync(SESSION_FILE)) {
    saveJSON(SESSION_FILE, { version: "2.0", scars: [] });
  }

  if (!existsSync(PROFILE_FILE)) {
    saveJSON(PROFILE_FILE, getDefaultProfile());
  }

  if (!existsSync(LOG_FILE)) {
    saveJSON(LOG_FILE, { version: "2.0", entries: [] });
  }

  console.log("SCAR v2.0 initialized");
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);

  switch (args[0]) {
    case "init":
      initialize();
      break;

    case "record":
      if (args.length < 3) {
        console.log("Usage: scar-learn.ts record <pattern> <correction> [context JSON]");
        process.exit(1);
      }
      const pattern = args[1];
      const correction = args[2];
      const context = args[3] ? JSON.parse(args[3]) : {};
      const isPermanent = args[4] !== "--session";

      const scar = recordCorrection(pattern, correction, context, isPermanent);
      console.log(JSON.stringify(scar, null, 2));
      break;

    case "list":
      const data = loadJSON<LongTermData>(LONG_TERM_FILE, { version: "2.0", scars: [] });
      console.log(`Found ${data.scars.length} long-term SCARs:`);
      data.scars.forEach(s => {
        console.log(`  [${s.confidence.toFixed(2)}] ${s.pattern.slice(0, 50)}...`);
      });
      break;

    case "profile":
      const profile = loadJSON<UserProfile>(PROFILE_FILE, getDefaultProfile());
      console.log(JSON.stringify(profile, null, 2));
      break;

    default:
      console.log("SCAR Learning Engine v2.0");
      console.log("Commands:");
      console.log("  init                    Initialize SCAR system");
      console.log("  record <pattern> <correction> [context]  Record a correction");
      console.log("  list                    List all SCARs");
      console.log("  profile                 Show user profile");
  }
}

export { SCAR, SessionSCAR, UserProfile, ActionLogEntry };
