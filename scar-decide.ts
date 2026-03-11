#!/usr/bin/env bun
/**
 * SCAR Decision Engine v2.0
 * Uses Thompson Sampling for the uncertainty zone
 * Implements the decision matrix: confidence + stakes = outcome
 */

import { matchAction, MatchResult } from "./scar-match";
import { logAction, triggerSCAR } from "./scar-learn";
import { getContextSummary, isDuringActiveTask, actionMatchesContext } from "./scar-context";
import { detectChangePoint, recordBehavior } from "./scar-changepoint";

// Decision outcomes
type DecisionOutcome = "allow" | "block" | "ask" | "log";

interface Decision {
  outcome: DecisionOutcome;
  confidence: number;
  uncertainty: number;
  scarMatch: MatchResult | null;
  reason: string;
  message: string | null;
}

interface Stakes {
  level: "low" | "medium" | "high";
  reversible: boolean;
  dataLoss: boolean;
  externalEffects: boolean;
}

// Polymorphic block messages (avoids habituation)
const BLOCK_MESSAGES = [
  "Hold up - that doesn't match what you've taught me.",
  "I stopped that based on what you told me before.",
  "Skipping that - remember when you said not to?",
  "Not doing that. Want me to explain why?",
  "Blocked. This looks like something you corrected me on.",
  "Wait - that conflicts with a lesson you taught me.",
  "I'm not doing that. Check the dashboard if you disagree.",
];

let lastMessageIndex = -1;

/**
 * Make a decision about an action
 * Enhanced with context awareness and changepoint detection
 */
export function decide(
  action: string,
  context: Record<string, any> = {},
  stakesInput?: Partial<Stakes>
): Decision {
  // 1. Get session context
  const sessionContext = getContextSummary();
  const isActiveTask = isDuringActiveTask();
  const matchesContext = actionMatchesContext(action);

  // 2. Match against learned SCARs
  const match = matchAction(action, { ...context, ...sessionContext });

  // 3. Determine stakes
  const stakes = determineStakes(action, context, stakesInput);

  // 4. If no match, allow and log
  if (!match.matched) {
    logAction(action, context, null, 0, 1, "logged");
    return {
      outcome: "allow",
      confidence: 0,
      uncertainty: 1,
      scarMatch: null,
      reason: "No SCAR matched - allowing",
      message: null,
    };
  }

  const confidence = match.confidence;
  const uncertainty = match.uncertainty;

  // 5. Check for change point (permanent vs temporary)
  const changePoint = detectChangePoint(match.pattern || action, context);

  // 6. Context bonus: if action matches current task, be less aggressive
  let adjustedConfidence = confidence;
  if (matchesContext && stakes.level === "low") {
    // User is actively working on this - be less intrusive
    adjustedConfidence = confidence * 0.8;
  }

  // 7. Active task penalty: don't interrupt during active work unless high stakes
  if (isActiveTask && stakes.level !== "high" && adjustedConfidence < 0.8) {
    // Log but don't block during active tasks for medium/low stakes
    logAction(action, context, match.scarId, adjustedConfidence, uncertainty, "logged");
    recordBehavior(match.pattern || action, action, "logged", context);
    return {
      outcome: "log",
      confidence: adjustedConfidence,
      uncertainty,
      scarMatch: match,
      reason: "Active task - logging instead of interrupting",
      message: null,
    };
  }

  // 8. Thompson Sampling for uncertainty zone (40-70% confidence)
  if (adjustedConfidence >= 0.40 && adjustedConfidence <= 0.70) {
    return thompsonSamplingDecision(action, context, match, stakes, changePoint);
  }

  // 9. Decision matrix for other confidence levels
  return matrixDecision(action, context, match, stakes, changePoint);
}

/**
 * Thompson Sampling decision for uncertainty zone
 * Exploration rate proportional to uncertainty
 */
function thompsonSamplingDecision(
  action: string,
  context: Record<string, any>,
  match: MatchResult,
  stakes: Stakes,
  changePoint: { isPermanent: boolean; confidence: number }
): Decision {
  // Beta distribution sample
  // Higher uncertainty = higher variance = more exploration
  const alpha = match.confidence * 100;
  const beta = match.uncertainty * 100;

  const sample = betaSample(alpha, beta);

  // Boost confidence if this is a permanent shift
  const effectiveSample = changePoint.isPermanent
    ? sample + 0.1 * changePoint.confidence
    : sample;

  // Decision based on sample and stakes
  if (effectiveSample > 0.6) {
    // Sample suggests block
    logAction(action, context, match.scarId, match.confidence, match.uncertainty, "auto_blocked");
    recordBehavior(match.pattern || action, action, "blocked", context);
    if (match.scarId) triggerSCAR(match.scarId);

    return {
      outcome: "block",
      confidence: match.confidence,
      uncertainty: match.uncertainty,
      scarMatch: match,
      reason: changePoint.isPermanent
        ? "Permanent shift detected - blocking"
        : "Thompson Sampling: high sample, blocking",
      message: getPolymorphicMessage(),
    };
  } else if (effectiveSample > 0.4 && stakes.level === "high") {
    // Medium sample + high stakes = ask
    logAction(action, context, match.scarId, match.confidence, match.uncertainty, "asked");
    recordBehavior(match.pattern || action, action, "corrected", context);

    return {
      outcome: "ask",
      confidence: match.confidence,
      uncertainty: match.uncertainty,
      scarMatch: match,
      reason: "Thompson Sampling: uncertain + high stakes",
      message: `This might be something you corrected me on: "${match.correction}"`,
    };
  } else {
    // Low sample = allow but log
    logAction(action, context, match.scarId, match.confidence, match.uncertainty, "logged");
    recordBehavior(match.pattern || action, action, "logged", context);

    return {
      outcome: "log",
      confidence: match.confidence,
      uncertainty: match.uncertainty,
      scarMatch: match,
      reason: "Thompson Sampling: low sample, logging",
      message: null,
    };
  }
}

/**
 * Decision matrix for clear confidence levels
 */
function matrixDecision(
  action: string,
  context: Record<string, any>,
  match: MatchResult,
  stakes: Stakes,
  changePoint: { isPermanent: boolean; confidence: number }
): Decision {
  const { confidence, uncertainty } = match;

  // 0-30%: Log only
  if (confidence < 0.31) {
    logAction(action, context, match.scarId, confidence, uncertainty, "logged");
    recordBehavior(match.pattern || action, action, "logged", context);
    return {
      outcome: "log",
      confidence,
      uncertainty,
      scarMatch: match,
      reason: "Low confidence - logging only",
      message: null,
    };
  }

  // 31-39%: Log + highlight
  if (confidence < 0.40) {
    logAction(action, context, match.scarId, confidence, uncertainty, "logged");
    recordBehavior(match.pattern || action, action, "logged", context);
    return {
      outcome: "log",
      confidence,
      uncertainty,
      scarMatch: match,
      reason: "Below uncertainty zone - logging",
      message: null,
    };
  }

  // 71-80%: Ask or log depending on stakes
  if (confidence < 0.81) {
    if (stakes.level === "high") {
      logAction(action, context, match.scarId, confidence, uncertainty, "asked");
      recordBehavior(match.pattern || action, action, "corrected", context);
      return {
        outcome: "ask",
        confidence,
        uncertainty,
        scarMatch: match,
        reason: "Medium-high confidence + high stakes",
        message: `I think this conflicts with: "${match.correction}"`,
      };
    } else {
      logAction(action, context, match.scarId, confidence, uncertainty, "logged");
      recordBehavior(match.pattern || action, action, "logged", context);
      return {
        outcome: "log",
        confidence,
        uncertainty,
        scarMatch: match,
        reason: "Medium-high confidence - logging",
        message: null,
      };
    }
  }

  // 81-95%: Auto-block
  if (confidence < 0.96) {
    logAction(action, context, match.scarId, confidence, uncertainty, "auto_blocked");
    recordBehavior(match.pattern || action, action, "blocked", context);
    if (match.scarId) triggerSCAR(match.scarId);

    return {
      outcome: "block",
      confidence,
      uncertainty,
      scarMatch: match,
      reason: changePoint.isPermanent
        ? "Permanent preference shift detected"
        : "High confidence - auto blocking",
      message: getPolymorphicMessage(),
    };
  }

  // 96-100%: Permanent rule
  logAction(action, context, match.scarId, confidence, uncertainty, "auto_blocked");
  recordBehavior(match.pattern || action, action, "blocked", context);
  if (match.scarId) triggerSCAR(match.scarId);

  return {
    outcome: "block",
    confidence,
    uncertainty,
    scarMatch: match,
    reason: "Permanent rule - blocking",
    message: getPolymorphicMessage(),
  };
}

/**
 * Determine stakes level for an action
 */
function determineStakes(
  action: string,
  context: Record<string, any>,
  input?: Partial<Stakes>
): Stakes {
  const actionLower = action.toLowerCase();

  // Check for high-stakes keywords
  const highStakesKeywords = [
    "rm -rf", "delete", "drop table", "truncate",
    "push --force", "reset --hard", "sudo",
    "format", "wipe", "destroy", "/etc/",
    "chmod 777", "dd if=", "> /dev/sd",
  ];

  const mediumStakesKeywords = [
    "push", "merge", "rebase", "chmod",
    "chown", "mv ", "cp -r", "git push",
    "npm publish", "docker push",
  ];

  const hasHighStakes = highStakesKeywords.some(k => actionLower.includes(k));
  const hasMediumStakes = mediumStakesKeywords.some(k => actionLower.includes(k));

  const reversible = !hasHighStakes && !actionLower.includes("delete");
  const dataLoss = hasHighStakes || actionLower.includes("drop");
  const externalEffects = actionLower.includes("push") || actionLower.includes("deploy");

  let level: "low" | "medium" | "high";
  if (hasHighStakes || dataLoss) {
    level = "high";
  } else if (hasMediumStakes || externalEffects) {
    level = "medium";
  } else {
    level = "low";
  }

  return {
    level: input?.level || level,
    reversible: input?.reversible ?? reversible,
    dataLoss: input?.dataLoss ?? dataLoss,
    externalEffects: input?.externalEffects ?? externalEffects,
  };
}

/**
 * Sample from Beta distribution (approximation)
 */
function betaSample(alpha: number, beta: number): number {
  // Simple approximation using ratio of gammas
  const x = gammaSample(alpha, 1);
  const y = gammaSample(beta, 1);
  return x / (x + y);
}

/**
 * Sample from Gamma distribution (Marsaglia and Tsang's method)
 */
function gammaSample(shape: number, scale: number): number {
  if (shape < 1) {
    return gammaSample(shape + 1, scale) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x, v;
    do {
      x = randomNormal();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) {
      return d * v * scale;
    }

    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v * scale;
    }
  }
}

/**
 * Standard normal random variable (Box-Muller)
 */
function randomNormal(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Get polymorphic message (rotates to avoid habituation)
 */
function getPolymorphicMessage(): string {
  let index;
  do {
    index = Math.floor(Math.random() * BLOCK_MESSAGES.length);
  } while (index === lastMessageIndex && BLOCK_MESSAGES.length > 1);

  lastMessageIndex = index;
  return BLOCK_MESSAGES[index];
}

/**
 * Quick check if action should be blocked (for hooks)
 */
export function shouldBlock(action: string, context: Record<string, any> = {}): boolean {
  const decision = decide(action, context);
  return decision.outcome === "block";
}

/**
 * Get decision with full details (for debugging)
 */
export function getDecisionDetails(action: string, context: Record<string, any> = {}): Decision {
  return decide(action, context);
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log("SCAR Decision Engine v2.0");
    console.log("Usage:");
    console.log("  scar-decide.ts <action> [context JSON]  - Get decision");
    console.log("  scar-decide.ts check <action>           - Quick block check");
    process.exit(1);
  }

  if (args[0] === "check") {
    const action = args[1];
    const blocked = shouldBlock(action);
    console.log(blocked ? "BLOCK" : "ALLOW");
    process.exit(blocked ? 1 : 0);
  }

  const action = args[0];
  const context = args[1] ? JSON.parse(args[1]) : {};

  const decision = decide(action, context);
  console.log(JSON.stringify(decision, null, 2));
}

export { Decision, DecisionOutcome, Stakes };
