# SCAR v2.0 Build Report

## What We Built

A learning system that blocks bad patterns automatically - no approval queue.

## Files

| File | What It Does |
|------|--------------|
| `scar-learn.ts` | Records your corrections as lessons |
| `scar-match.ts` | Matches actions against learned lessons |
| `scar-decide.ts` | Decides: allow, block, or log |
| `scar-hook.ts` | Integrates with Claude Code |
| `scar-context.ts` | Tracks what you're working on |
| `scar-changepoint.ts` | Detects permanent vs temporary patterns |

## Why We Built It

**Old SCAR**: Approval queue - asked you about everything, 90% false positives, confused you.

**New SCAR**: Learning system - learns once, auto-blocks forever.

## How It Decides

| Confidence | What Happens |
|------------|--------------|
| 0-40% | Log only |
| 40-70% | Thompson Sampling (probabilistic) |
| 70-80% | Ask if high stakes, else log |
| 81%+ | Auto-block |

## Key Features

1. **Learns once** - You correct it, it remembers
2. **Context-aware** - Knows what project you're working on
3. **Less interrupting** - Logs during active work unless dangerous
4. **Polymorphic messages** - Rotates phrasing to avoid habituation
5. **Change detection** - Knows permanent shifts vs temporary exceptions

## How to Use

```bash
# Teach it something
cd ~/.claude/PAI/SCAR && bun scar-learn.ts record "pattern" "what to do instead"

# See what it learned
cd ~/.claude/PAI/SCAR && bun scar-learn.ts list

# Test a decision
cd ~/.claude/PAI/SCAR && bun scar-decide.ts "your command here"
```

Or just tell me in conversation: "Next time do X instead of Y"

---

*Built: 2026-03-11*
