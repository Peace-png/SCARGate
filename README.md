# SCARGate

**The Guard at the Door.**

Stop your AI from making the same mistakes twice.

---

## What It Does

SCARGate intercepts AI actions BEFORE they happen and blocks ones that violate your principles.

```
Without SCARGate:
  AI makes mistake → You notice → You fix it → AI forgets → Repeat

With SCARGate:
  AI about to make mistake → SCARGate blocks → Shows principle → AI corrects
```

---

## How It Works

1. **Write Principles** - Define what your AI should/shouldn't do
2. **Wire the Hook** - Add SCARGate to your AI's PreToolUse event
3. **Protected** - Violations get blocked with context on what to do instead

---

## Quick Start

```bash
# Install
bun add scargate

# Or clone
git clone https://github.com/YOUR_USERNAME/SCARGate
```

### 1. Create Your Principles

Create `principles/SOUL.md`:

```markdown
### P1: Verify Before Acting

**RULE:** Always check files before moving, renaming, or deleting.

**WHY:** I broke 11 files by assuming things were fine.

**CONSEQUENCE LEVEL:** High

**CONSTRAINTS:**
1. List folder contents before any delete operation
2. Search for references before moving files
3. Ask when uncertain

**Remember:**
> "Check the pocket before you throw away the pants."
```

### 2. Wire the Hook

Add to your AI's PreToolUse hook:

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "bun /path/to/SCARGate.hook.ts" }
    ]
  }
}
```

### 3. Test It

Ask your AI to delete something without checking. It should get blocked.

---

## What Gets Blocked

SCARGate blocks when ALL conditions match:

| Condition | Threshold |
|-----------|-----------|
| Relevance | >= 80% (principle matches the action) |
| Level | Critical or High consequence |
| Constraints | Principle has actionable checks |

Low/Medium principles just advise. High/Critical ones block.

---

## Principle Format

```markdown
### P{number}: {Name}

**RULE:** What the principle requires

**WHY:** Origin story (why this matters)

**ORIGIN:** When/how this was learned

**CONSEQUENCE LEVEL:** Critical | High | Medium | Low

**YIN — What I did:**
The mistake that led to this principle

**YANG — What that caused:**
The consequences of that mistake

**CONSTRAINTS:**
1. First actionable check
2. Second actionable check
3. Third actionable check

**Remember:**
> A memorable phrase that captures the essence
```

---

## Example Principles

See `principles/SOUL.md` for 14 real principles from production use:

- P1: Verify Before Acting (stops file destruction)
- P5: Substrate Reality (stops hallucination)
- P7: Error Ownership (stops defensive lying)
- P11: Silent Churn (stops losing non-coders)

---

## Why "SCAR"?

SCAR = **S**elf-**C**orrecting **A**rchitecture for **R**eliability

Also: Scars are how we remember wounds. Principles are scars encoded as rules.

---

## Philosophy

> "The first lie is a mistake. The second lie is a choice. When caught, collapse immediately—do not build a wall around the error."

SCARGate exists because:
- AI systems repeat mistakes
- Humans shouldn't have to supervise every action
- Principles work better when enforced, not just displayed

---

## License

MIT

---

## Credits

Built from the Keystone Personal AI Infrastructure project.

The principles in `principles/SOUL.md` were learned the hard way—by making mistakes and documenting them.
