#!/usr/bin/env bun
/**
 * SCAR Pattern Matcher v2.0
 * Matches actions against learned SCARs with confidence scoring
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const SCAR_DIR = join(process.env.HOME!, ".claude/PAI/SCAR");
const LONG_TERM_FILE = join(SCAR_DIR, "scars_long_term.json");
const SESSION_FILE = join(SCAR_DIR, "scars_session.json");

interface MatchResult {
  matched: boolean;
  scarId: string | null;
  pattern: string | null;
  correction: string | null;
  confidence: number;
  uncertainty: number;
  isSession: boolean;
  reason: string;
}

interface SCAR {
  id: string;
  pattern: string;
  correction: string;
  confidence: number;
  uncertainty: number;
  contexts: string[];
}

interface SessionSCAR {
  id: string;
  parentId: string | null;
  pattern: string;
  context: Record<string, any>;
  override: string;
  confidence: number;
  expiresAt: string;
  reverted: boolean;
}

interface LongTermData {
  version: string;
  scars: SCAR[];
}

interface SessionData {
  version: string;
  scars: SessionSCAR[];
}

/**
 * Check if action matches any SCAR
 */
export function matchAction(
  action: string,
  context: Record<string, any> = {}
): MatchResult {
  // First check session SCARs (contextual exceptions)
  const sessionMatch = matchSession(action, context);
  if (sessionMatch.matched) {
    return sessionMatch;
  }

  // Then check long-term SCARs
  return matchLongTerm(action, context);
}

/**
 * Match against session SCARs (contextual exceptions)
 */
function matchSession(
  action: string,
  context: Record<string, any>
): MatchResult {
  if (!existsSync(SESSION_FILE)) {
    return noMatch();
  }

  try {
    const data: SessionData = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    const now = Date.now();

    for (const scar of data.scars || []) {
      // Skip expired or reverted
      if (scar.reverted || new Date(scar.expiresAt).getTime() < now) {
        continue;
      }

      // Check context match
      if (context && scar.context) {
        const contextMatch = Object.entries(scar.context).every(
          ([key, val]) => context[key] === val
        );
        if (!contextMatch) continue;
      }

      // Check pattern match
      if (matchesPattern(action, scar.pattern)) {
        return {
          matched: true,
          scarId: scar.id,
          pattern: scar.pattern,
          correction: scar.override,
          confidence: scar.confidence,
          uncertainty: 0.4, // Session SCARs have higher uncertainty
          isSession: true,
          reason: `Session exception: ${scar.override}`,
        };
      }
    }
  } catch (e) {
    // If file is corrupted or empty, just return no match
  }

  return noMatch();
}

/**
 * Match against long-term SCARs (permanent lessons)
 */
function matchLongTerm(
  action: string,
  context: Record<string, any>
): MatchResult {
  if (!existsSync(LONG_TERM_FILE)) {
    return noMatch();
  }

  try {
    const data: LongTermData = JSON.parse(readFileSync(LONG_TERM_FILE, "utf-8"));
    let bestMatch: MatchResult = noMatch();

    for (const scar of data.scars || []) {
      const patternScore = patternMatchScore(action, scar.pattern);

      if (patternScore > 0.3) {
        // Check context relevance
        const contextBonus = calculateContextBonus(context, scar.contexts);

        const combinedConfidence = Math.min(
          scar.confidence * patternScore + contextBonus,
          0.99
        );

        if (combinedConfidence > bestMatch.confidence) {
          bestMatch = {
            matched: true,
            scarId: scar.id,
            pattern: scar.pattern,
            correction: scar.correction,
            confidence: combinedConfidence,
            uncertainty: scar.uncertainty,
            isSession: false,
            reason: `Match (${(patternScore * 100).toFixed(0)}%): ${scar.correction.slice(0, 60)}...`,
          };
        }
      }
    }

    return bestMatch;
  } catch (e) {
    return noMatch();
  }
}

/**
 * Calculate pattern match score (0-1)
 */
function patternMatchScore(action: string, pattern: string): number {
  const actionLower = action.toLowerCase();
  const patternLower = pattern.toLowerCase();

  // Exact match
  if (actionLower === patternLower) return 1.0;

  // Substring match
  if (actionLower.includes(patternLower)) return 0.9;
  if (patternLower.includes(actionLower)) return 0.8;

  // Word overlap (Jaccard similarity)
  const actionWords = new Set(actionLower.split(/\s+/).filter(w => w.length > 2));
  const patternWords = new Set(patternLower.split(/\s+/).filter(w => w.length > 2));

  if (actionWords.size === 0 || patternWords.size === 0) return 0;

  const intersection = [...actionWords].filter(w => patternWords.has(w));
  const union = new Set([...actionWords, ...patternWords]);

  const jaccard = intersection.size / union.size;

  // Boost if key danger words match
  const dangerWords = ["delete", "remove", "push", "force", "sudo", "rm", "drop", "truncate", "wipe"];
  const hasDangerWord = dangerWords.some(w =>
    actionWords.has(w) && patternWords.has(w)
  );

  if (hasDangerWord) {
    return Math.min(jaccard + 0.3, 1.0);
  }

  // Boost for any word overlap
  if (intersection.size >= 2) {
    return Math.min(jaccard + 0.1, 1.0);
  }

  return jaccard;
}

/**
 * Simple boolean pattern match
 */
function matchesPattern(action: string, pattern: string): boolean {
  return patternMatchScore(action, pattern) > 0.5;
}

/**
 * Calculate context bonus for confidence
 */
function calculateContextBonus(
  actionContext: Record<string, any>,
  scarContexts: string[]
): number {
  if (!actionContext || !scarContexts || scarContexts.length === 0) {
    return 0;
  }

  const project = actionContext.project || "general";
  const task = actionContext.task || "";

  let bonus = 0;

  // Project match
  if (scarContexts.includes(project)) {
    bonus += 0.1;
  }

  // Task type match
  if (task && scarContexts.includes(task)) {
    bonus += 0.05;
  }

  return bonus;
}

/**
 * No match result
 */
function noMatch(): MatchResult {
  return {
    matched: false,
    scarId: null,
    pattern: null,
    correction: null,
    confidence: 0,
    uncertainty: 1,
    isSession: false,
    reason: "No SCAR matched",
  };
}

/**
 * Get all SCARs that partially match (for suggestions)
 */
export function getRelatedSCARs(action: string, threshold: number = 0.2): MatchResult[] {
  if (!existsSync(LONG_TERM_FILE)) {
    return [];
  }

  try {
    const data: LongTermData = JSON.parse(readFileSync(LONG_TERM_FILE, "utf-8"));
    const results: MatchResult[] = [];

    for (const scar of data.scars || []) {
      const score = patternMatchScore(action, scar.pattern);
      if (score > threshold) {
        results.push({
          matched: true,
          scarId: scar.id,
          pattern: scar.pattern,
          correction: scar.correction,
          confidence: scar.confidence * score,
          uncertainty: scar.uncertainty,
          isSession: false,
          reason: `Related (${(score * 100).toFixed(0)}%)`,
        });
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  } catch {
    return [];
  }
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log("SCAR Pattern Matcher v2.0");
    console.log("Usage:");
    console.log("  scar-match.ts <action> [context JSON]  - Match action against SCARs");
    console.log("  scar-match.ts related <action>         - Find related SCARs");
    process.exit(1);
  }

  if (args[0] === "related") {
    const action = args[1];
    const results = getRelatedSCARs(action);
    console.log(`Found ${results.length} related SCARs:`);
    results.forEach(r => {
      console.log(`  [${r.confidence.toFixed(2)}] ${r.pattern}`);
    });
  } else {
    const action = args[0];
    const context = args[1] ? JSON.parse(args[1]) : {};

    const result = matchAction(action, context);
    console.log(JSON.stringify(result, null, 2));
  }
}

export { MatchResult };
