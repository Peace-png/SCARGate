# STACK.md - System Architecture

The tree structure of "us" - Peace + PAI + SCARGate + HumanLayer.

```
PEACE (Human)
│
├── IDENTITY
│   ├── Name: Peace
│   ├── GitHub: Peace-png
│   ├── Platform: Linux
│   └── Constraint: Cannot verify code independently
│
├── TELOS (Why)
│   ├── WISDOM.md ──────► 14 Principles (scars)
│   │   ├── P1: Verify paths before action
│   │   ├── P3: Terminal doesn't lie
│   │   ├── P5: Nihilism over narrative
│   │   ├── P6: No layer testifies to own health
│   │   ├── P7: Collapse when caught
│   │   └── ... (9 more)
│   ├── BELIEFS.md ─────► Worldview & philosophy
│   └── CHALLENGES.md ──► Constraints & needs
│
├── PAI 4.0.0 (How I work)
│   ├── ALGORITHM ──────► 7-phase processing
│   │   ├── 1. Context Load
│   │   ├── 2. Classification
│   │   ├── 3. ISC Generation
│   │   ├── 4. Capability Matching
│   │   ├── 5. Execution
│   │   ├── 6. Verification
│   │   └── 7. Reflection
│   │
│   ├── HOOKS (20) ─────► Governance gates
│   │   ├── SCARGate.hook ──► Blocks dangerous actions
│   │   ├── PreToolUse ─────► Intercept tool calls
│   │   └── ... (18 more)
│   │
│   ├── SKILLS (25+) ───► Specialized capabilities
│   │   ├── Research ──────► Multi-agent web research
│   │   ├── Media ─────────► Visual content creation
│   │   ├── Security ──────► Pentesting & recon
│   │   ├── Telos ─────────► Life OS & goals
│   │   └── ... (21 more)
│   │
│   └── COMMANDS ───────► HumanLayer (27)
│       ├── /research ──► Deep investigation
│       ├── /plan ──────► Architecture design
│       ├── /implement ─► TDD coding
│       └── ... (24 more)
│
├── SCARGate (Conscience)
│   ├── scar-daemon.ts ──► Matches actions to scars
│   ├── WISDOM.md ───────► Principle source
│   └── Trigger ──────────► PreToolUse hook
│       ├── READ-ONLY TOOLS (always pass):
│       │   ├── Read, Glob, Grep, WebSearch
│       │   ├── TaskOutput, TaskList, TaskGet
│       │   └── Bash: ls, cat, git status, grep, etc.
│       │
│       └── BLOCKS write/delete when:
│           ├── Relevance >= 80%
│           ├── Level = Critical/High
│           └── Has constraints
│
│       Examples BLOCKED:
│       • rm -rf /home/... → P1 (verify before delete)
│       • mv /home/... → P1 (check references first)
│       • Write /home/... → P1 (verify path)
│
└── HumanLayer (Approval)
    ├── 27 Commands ─────► Workflow gates
    └── 6 Agents ────────► Research perspectives
```

---

## Request Flow

```
Request → SCARGate check → PAI Algorithm → Skill execution → Verification
```

1. **Request comes in** - User asks for something
2. **SCARGate intercepts** - Checks against 14 principles
3. **PAI Algorithm** - 7-phase processing begins
4. **Skill execution** - Relevant skill does the work
5. **Verification** - Evidence provided, not claims

---

## Core Truth

You + PAI + SCARGate = a system where:

- Your scars become automated protection
- AI shows evidence before claiming success
- **Write/delete actions get blocked** (reads pass freely)
- 14 principles guard against repeating past failures

---

## Files & Locations

| Component | Location |
|-----------|----------|
| Identity | `~/.claude/PAI/USER/ABOUTME.md` |
| Principles | `~/.claude/PAI/USER/TELOS/WISDOM.md` |
| Beliefs | `~/.claude/PAI/USER/TELOS/BELIEFS.md` |
| Challenges | `~/.claude/PAI/USER/TELOS/CHALLENGES.md` |
| Algorithm | `~/.claude/PAI/Algorithm/v3.5.0.md` |
| SCAR Daemon | `~/.claude/PAI/SCAR/scar-daemon.ts` |
| SCARGate Hook | `~/.claude/hooks/SCARGate.hook.ts` |
| Skills | `~/.claude/skills/*.md` |
| Commands | `~/.claude/commands/*.md` |

---

## SCARGate Tuning (2026-03-10)

**Problem:** Original SCARGate blocked ALL tools matching scar triggers, including reads.

**Solution:** Added `isReadOnly()` function to classify tools:

| Category | Tools | Behavior |
|----------|-------|----------|
| Read-only | Read, Glob, Grep, WebSearch, TaskOutput, TaskList | Always pass |
| Read-only Bash | ls, cat, grep, git status, git log, etc. | Always pass |
| Write/delete | Write, Edit, rm, mv, etc. | SCAR checked |

**Why:** SCAR protects against *destructive* actions. Information gathering should never be blocked.
