# SCARGate

[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**The Guard at the Door** — principle-based AI action blocking.

## TL;DR

SCARGate stops your AI from making the same mistakes twice. It blocks dangerous actions before they happen and shows your AI what to do instead.

```
Without SCARGate:
  AI makes mistake → You notice → You fix it → AI forgets → Repeat

With SCARGate:
  AI about to make mistake → SCARGate blocks → Shows principle → AI corrects
```

---

## For Non-Coders (Start Here)

**You don't need to know how to code to use this.**

SCARGate was built by someone who can't verify code. Every feature exists because something actually went wrong.

### What SCARGate Does (Plain English)

Your AI assistant (Claude) can delete files, move things around, and push code to GitHub. Sometimes it gets confident and does things it shouldn't.

SCARGate is like a bouncer. Before Claude does anything risky, SCARGate checks:
- "Wait, does this break one of Peace's rules?"
- If yes → Block it, show the rule, suggest what to do instead
- If no → Let it through

### Why This Matters

If you're a non-coder using AI:
- You can't verify if the code works
- When AI says "it's done" — you have to trust it
- When something breaks — you don't know why
- You don't file bug reports. You just leave.

SCARGate is AI governance that doesn't require you to be technical. You write rules in plain English. The system enforces them.

### One-Command Install

Open Claude Code and type:

```
/plugin install https://github.com/Peace-png/SCARGate
```

That's it. SCARGate is now protecting your session.

### Your First Principle

Edit `principles/SOUL.md` and add a rule like this:

```markdown
### P1: Always Ask Before Deleting

**RULE:** Never delete files without showing me what's inside first.

**WHY:** I lost work because AI deleted a folder it thought was empty.

**CONSEQUENCE LEVEL:** High

**CONSTRAINTS:**
1. Show folder contents before any delete
2. Ask me to confirm

**Remember:**
> "Check the pocket before you throw away the pants."
```

Now your AI can't delete anything without checking first.

### If Something Goes Wrong

Just say: *"Look in my SCARGate folder and help me fix it."*

Claude will help you diagnose the issue.

---

## How It Works

1. **You write principles** — Rules in plain English about what your AI should/shouldn't do
2. **SCARGate installs automatically** — Hooks into your Claude Code session
3. **Protected** — When AI tries something risky, SCARGate checks against your principles

### What Gets Blocked

| Your Action | SCARGate Behavior |
|-------------|-------------------|
| Reading files | ✅ Always allowed |
| Searching | ✅ Always allowed |
| `ls`, `cat`, `git status` | ✅ Always allowed |
| Deleting files | 🛔 Blocked if matches principle |
| Moving/renaming | 🛔 Blocked if matches principle |
| Push to GitHub | 🛔 Blocked if matches principle |

SCARGate blocks when:
- The action matches one of your principles (80%+ relevance)
- The principle is marked "High" or "Critical" consequence
- The principle has specific checks to follow

### Read-Only Protection

SCARGate never blocks information gathering. It only blocks *destructive* actions. You can always read, search, and explore — the protection kicks in when something is about to change or be deleted.

---

## Principle Format

```markdown
### P{number}: {Name}

**RULE:** What the principle requires

**WHY:** Why this matters (the origin story)

**CONSEQUENCE LEVEL:** Critical | High | Medium | Low

**YIN — What I did:**
The mistake that led to this principle

**YANG — What that caused:**
What went wrong because of that mistake

**CONSTRAINTS:**
1. First check to perform
2. Second check to perform
3. Third check to perform

**Remember:**
> A memorable phrase that captures the essence
```

**Levels:**
- **Critical/High** → Blocks the action
- **Medium/Low** → Advises but doesn't block

---

## Example Principles

The repo includes 14 real principles from production use:

| Principle | What It Stops |
|-----------|---------------|
| P1: Verify Before Acting | Deleting without checking |
| P5: Substrate Reality | Hallucinating content that doesn't exist |
| P7: Error Ownership | Defending mistakes instead of owning them |
| P11: Silent Churn | Losing non-coder users silently |

See `principles/WISDOM.md` for the full set.

---

## For Developers

### Install

```bash
/plugin install https://github.com/Peace-png/SCARGate
```

### Dev Setup

```bash
git clone https://github.com/Peace-png/SCARGate.git
cd SCARGate
bun install
```

Run the daemon:
```bash
bun scar-daemon.ts start
```

Test a match:
```bash
bun scar-daemon.ts match "delete this folder"
```

### Repository Structure

| File | Purpose |
|------|---------|
| `plugin.json` | Plugin manifest for Claude Code |
| `scar-daemon.ts` | Principle matching engine |
| `hooks/SCARGate.hook.ts` | The guard - blocks tool calls |
| `principles/WISDOM.md` | Example principles (14 real ones) |
| `docs/STACK.md` | System architecture |

---

## Why "SCAR"?

SCAR = **S**elf-**C**orrecting **A**rchitecture for **R**eliability

Also: Scars are how we remember wounds. Every principle in this system exists because something actually went wrong. These aren't theoretical rules — they're lessons encoded as protection.

---

## Philosophy

> "The first lie is a mistake. The second lie is a choice. When caught, collapse immediately—do not build a wall around the error."

SCARGate exists because:
- AI systems repeat mistakes
- Non-coders can't verify code
- Principles work better when enforced, not just displayed
- No-code AI governance shouldn't require technical knowledge

---

## Who This Is For

- **Non-coders using AI** — You want protection without needing to understand code
- **AI governance** — You need principled AI behavior, not just prompts
- **No-code workflows** — You work with AI but don't write software

This combination — **non-coder + no-code + ai-governance** — doesn't exist anywhere else.

---

## Contributing

- Issues and PRs welcome
- Tag small tasks with `good first issue`
- Non-coder contributions especially valued — if something is confusing, that's a bug

---

## License

MIT — see [LICENSE](LICENSE)

---

## Credits

Built from the Keystone Personal AI Infrastructure project.

The principles in `principles/WISDOM.md` were learned the hard way—by making mistakes and documenting them.
