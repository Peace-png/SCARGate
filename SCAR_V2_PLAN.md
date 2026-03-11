# SCAR v2.0 - Learning System Rebuild Plan

## The Problem

Current SCAR is an **approval engine** that asks the human about everything. This:
- Creates 90%+ false positives (asks about harmless stuff)
- Trains users to ignore it (research shows <50% accuracy = systematic ignore)
- Confuses non-coders with technical messages
- Doesn't learn - same questions forever

## The Solution

SCAR v2.0 is a **learning system** that:
- Records corrections ONCE
- Builds confidence from repeated patterns
- Auto-blocks at high confidence (no human needed)
- Only interrupts for genuinely new/ambiguous situations
- Logs everything for dashboard review
- **Distinguishes permanent preferences from contextual exceptions**

---

## Architecture

### 1. Dual-Timescale Data Model

Based on Spotify/Netflix/YouTube production architecture: `preference = long_term_vector + context_dependent_offset`

#### Long-Term SCAR (Permanent Lessons)
```json
{
  "id": "scar_001",
  "trigger": "poor research question",
  "pattern": "research questions that are vague or lack specificity",
  "correction": "Research questions must be specific, contextual, and designed for deep investigation",
  "examples": [
    {"bad": "how do I fix this", "good": "What UX patterns do browsers use for security warnings?"}
  ],
  "confidence": 0.95,
  "timesTriggered": 47,
  "timesCorrected": 1,
  "lastTriggered": "2026-03-11T18:00:00Z",
  "createdAt": "2026-03-11T12:00:00Z",
  "decayRate": 0.02,
  "stabilityScore": 0.89
}
```

#### Session SCAR (Contextual Exceptions)
```json
{
  "id": "session_scar_001",
  "parentId": "scar_011",
  "context": {"project": "SCARGate_fix", "task": "debugging"},
  "override": "allow git push in this context",
  "expiresAt": "2026-03-12T12:00:00Z",
  "triggerCount": 3,
  "reverted": false
}
```

#### Action Log (What Happened)
```json
{
  "id": "log_001",
  "timestamp": "2026-03-11T18:05:00Z",
  "action": "attempted_git_push",
  "context": {"project": "SCARGate_fix", "branch": "main", "task": "debugging"},
  "scarMatch": "scar_011",
  "confidence": 0.92,
  "uncertainty": 0.08,
  "outcome": "auto_blocked",
  "userReview": null
}
```

### 2. Permanent vs Temporary Detection

**The LinUCB Test (Production Standard):**
- If θ (preference weights) need to change → genuine preference shift
- If only x (context) changed → situational exception

**Detection Signals:**

| Signal | Permanent | Temporary |
|--------|-----------|-----------|
| Appears in ALL contexts | ✓ | |
| One context only | | ✓ |
| Persists across sessions | ✓ | |
| Reverts within N interactions | | ✓ |
| User explicitly sets rule | ✓ | |
| Magnitude of deviation (large) | ✓ | |

**Bayesian Online Change Point Detection (BOCPD):**
- Maintains "run length" = time since last genuine change
- Short run length + behavior change = changepoint detected
- Behavior reverts = second changepoint back = temporary blip

### 3. Confidence Scoring with Adaptive Forgetting

| Confidence | What Happens | Example |
|------------|--------------|---------|
| 0-30% | Log only, no action | First time seeing pattern |
| 31-40% | Uncertainty zone - explore | Thompson Sampling active |
| 41-60% | Log + dashboard highlight | Seen a few times, uncertain |
| 61-70% | Uncertainty zone - explore | Thompson Sampling active |
| 71-80% | Ask user (if during task), else log | Pattern emerging |
| 81-95% | Auto-block silently | High confidence, learned |
| 96-100% | Permanent rule | User explicitly set |

**Adaptive Forgetting (Learns Its Own Rate):**
```
decay_rate_t = decay_rate_{t-1} + meta_learning_rate * (observed_volatility - expected_volatility)
```
- User changes preferences often → higher decay rate
- User is stable → lower decay rate
- The decay rate ITSELF is a signal about preference stability

**Confidence Updates:**
- User corrects same thing → +20% (permanent signal)
- Same pattern triggers, no complaint → +5% per trigger
- User overrides block → -15% AND increase uncertainty
- User expresses frustration → -25%
- Behavior reverts within session → mark as contextual, not permanent

### 4. Navigating the Uncertainty Zone (40-70%)

**Thompson Sampling (Automatic Exploration):**
```typescript
// Instead of fixed threshold, sample from posterior
function shouldBlock(confidence: number, uncertainty: number): boolean {
  // Sample from Beta distribution centered on confidence
  const sample = betaSample(confidence * trials, (1 - confidence) * trials);
  // High uncertainty = high variance = more exploration
  return sample > 0.5;
}
```

**When to Ask vs Infer (BAL-PM Framework):**
- **Ask when:** High uncertainty AND context underrepresented in history
- **Infer when:** Uncertainty low OR context well-explored

**RUNE Uncertainty Bonus (Decays Over Time):**
```
r_effective = r_mean - α * uncertainty
where α decays exponentially: α_t = α_0 * (1-ρ)^t
```
Early: uncertainty dominates → explore aggressively
Later: uncertainty shrinks → exploit learned preferences

### 5. Contradiction Resolution (Never Discard)

**Bayesian Update Principle:**
- Contradictory signals → WIDEN uncertainty, never discard
- Posterior: P(θ|D) ∝ P(D|θ) * P(θ)
- If consistent action-fan watches two romances → posterior shifts slightly but retains action mass in WIDER distribution

**Temporal Weighting (Not Deletion):**
```typescript
function weightSignal(timestamp: Date, signalType: string): number {
  const age = now - timestamp;
  const decayRate = getAdaptiveDecayRate(user);

  // Explicit corrections decay slower than implicit signals
  const typeMultiplier = signalType === 'explicit' ? 0.5 : 1.0;

  return Math.exp(-decayRate * typeMultiplier * age);
}
```

**Change Detection vs Amnesia:**
- Don't forget old data when user contradicts
- Detect if it's a changepoint (permanent) or contextual (temporary)
- If changepoint: start new regime, keep old for reference
- If contextual: create session SCAR, don't modify long-term

### 6. Decision Matrix

```
                    LOW STAKES    MEDIUM STAKES    HIGH STAKES
LOW CONFIDENCE      Log only      Log only         Log + Ask
UNCERTAINTY ZONE    Thompson      Thompson         Thompson + Ask
MEDIUM CONFIDENCE   Log only      Log + Ask        Ask + Explain
HIGH CONFIDENCE     Auto-block    Auto-block       Auto-block + Log
PERMANENT RULE      Auto-block    Auto-block       Auto-block
```

**Stakes determination:**
- **Low**: Reversible, no data loss, user can undo
- **Medium**: Somewhat reversible, might need work to fix
- **High**: Irreversible, data loss, system changes, external effects

### 7. User Interface

#### Dashboard (Primary)
- Real-time log of all SCAR activity
- Filter by: confidence, uncertainty, stakes, outcome, time
- Review queue for uncertain decisions
- Learning progress: stability score, decay rate, changepoints detected
- Separate views: Long-term SCARs vs Session SCARs

#### Notifications (Minimal)
- Only for HIGH confidence blocks (so user knows something was stopped)
- Silent during active tasks (research shows 22.9% vs 8.8% ignore rate)
- Polymorphic - varies appearance to avoid habituation

#### Corrections (Easy)
- User says: "That was wrong, next time do X"
- SCAR asks (optional): "Always, or just in this context?"
- If always → update long-term SCAR
- If just now → create session SCAR
- No forms, no approval queue, just conversation

### 8. Polymorphic Messaging

To prevent habituation (brain ignores after 2 exposures):

```typescript
const BLOCK_MESSAGES = [
  "Hold up - that doesn't match what you've taught me.",
  "I stopped that based on what you told me before.",
  "Skipping that - remember when you said not to?",
  "Not doing that. Want me to explain why?",
  "Blocked. This looks like something you corrected me on."
];

// Rotate through messages, never same one twice in a row
// Add context variation: mention the specific SCAR matched
```

---

## Implementation Phases

### Phase 1: Core Learning System
1. Dual-timescale data model (long-term + session SCARs)
2. Confidence scoring with adaptive forgetting
3. Pattern matching against learned SCARs
4. Basic auto-block at high confidence
5. Action logging

### Phase 2: Decision Intelligence
1. Stakes detection (is this reversible? high impact?)
2. Context awareness (project, files, task)
3. Thompson Sampling for uncertainty zone
4. BOCPD for change detection
5. Decision matrix implementation

### Phase 3: Contradiction Handling
1. Bayesian updating (widen uncertainty, never discard)
2. Permanent vs temporary classification
3. Session SCAR creation for contextual exceptions
4. Adaptive decay rate learning

### Phase 4: User Interface
1. Dashboard v2 with dual-timescale views
2. Polymorphic messaging system
3. Easy correction capture with context check
4. Stats and learning progress visualization

### Phase 5: Migration
1. Import existing SCARs as low-confidence long-term entries
2. Keep old system as fallback during transition
3. Gradual rollout with monitoring
4. Kill old approval queue once stable

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| False positive rate | ~90% | <10% |
| User interruptions per session | 5-10 | 0-1 |
| Time to learn new preference | Never | 1 correction |
| User comprehension of blocks | ~30% | 80%+ |
| Blocks that are "thank you" moments | ~10% | 80%+ |
| Correct permanent vs temporary classification | N/A | 85%+ |
| User stability score accuracy | N/A | 90%+ |

---

## Key Research Backing

### UX Research (Warnings)
1. **50% accuracy threshold** - Manzey et al. (2014): Below 50% PPV, users systematically ignore warnings
2. **2-exposure habituation** - BYU Neurosecurity Lab: Brain tunes out after 2 exposures
3. **Opinionated design** - Felt et al. (2015): Structure > comprehension for safe behavior
4. **Polymorphic warnings** - Vance et al. (2018): 4+ visual variations sustain attention
5. **Contextual timing** - Jenkins et al. (2016): Interrupting tasks doubles ignore rate

### Preference Learning Research
1. **LinUCB framing** - Li et al. (2010): θ change vs x change distinguishes permanent from temporary
2. **BOCPD** - Adams & MacKay (2007): Bayesian change point detection for regime shifts
3. **Adaptive forgetting** - Ligneul & Bhatt (2019): Systems that learn their own decay rate outperform fixed
4. **Thompson Sampling** - Automatic exploration proportional to uncertainty
5. **BAL-PM** - NeurIPS 2024: Ask when high uncertainty AND context underrepresented
6. **Dual-timescale architecture** - Spotify CoSeRNN, Netflix Foundation Model, YouTube: production standard

---

## File Structure

```
~/.claude/PAI/SCAR/
├── scars_long_term.json     # Permanent lessons
├── scars_session.json       # Contextual exceptions
├── action_log.json          # What happened
├── user_profile.json        # Stability score, decay rate, preferences
├── settings.json            # Thresholds
├── dashboard.ts             # TUI dashboard
├── scar-learn.ts            # Learning engine
├── scar-match.ts            # Pattern matching
├── scar-decide.ts           # Thompson Sampling + decision matrix
├── scar-changepoint.ts      # BOCPD implementation
└── scar-hook.ts             # Integration with Claude Code
```

---

## Next Steps

1. Approve this plan
2. Build Phase 1 (Core Learning System)
3. Test with real corrections
4. Iterate based on results

---

*Plan created: 2026-03-11*
*Updated: 2026-03-11 with preference learning research*
*Based on: UX research + preference learning research (Spotify/Netflix/YouTube patterns) + user feedback*
