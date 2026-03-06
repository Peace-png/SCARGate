# SCARGate

[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**The Guard at the Door** — principle-based AI action blocking.

## TL;DR

SCARGate is a Claude Code plugin that intercepts AI actions BEFORE they happen and blocks ones that violate your principles. Stop your AI from making the same mistakes twice.

```
Without SCARGate:
  AI makes mistake → You notice → You fix it → AI forgets → Repeat

With SCARGate:
  AI about to make mistake → SCARGate blocks → Shows principle → AI corrects
```

---

## Install (in Claude Code)

```bash
/plugin install https://github.com/Peace-png/SCARGate
```

That's it. SCARGate is now protecting your session.

---

## What It Does

- **Intercepts** tool calls before they execute
- **Matches** against your principles in `principles/SOUL.md`
- **Blocks** high-consequence violations with context on what to do instead

---

## How It Works

1. **Write Principles** - Define what your AI should/shouldn't do in `principles/SOUL.md`
2. **Plugin Installs Hook** - SCARGate hooks into PreToolUse automatically
3. **Protected** - Violations get blocked with context on what to do instead

---

## Quick Start

### 1. Install the Plugin

```bash
/plugin install https://github.com/Peace-png/SCARGate
```

### 2. Add Your Principles

Edit `principles/SOUL.md` with your own rules:

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

### 3. Test It

Ask your AI to delete something without checking. It should get blocked.

---

## Demo

![demo-gif](docs/demo.gif)
*(Coming soon)*

---

## Developer Setup

```bash
git clone https://github.com/Peace-png/SCARGate.git
cd SCARGate
bun install
```

Run the daemon directly:
```bash
bun scar-daemon.ts start
```

Test a match:
```bash
bun scar-daemon.ts match "delete this folder"
```

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

## Repository Structure

| File | Purpose |
|------|---------|
| `plugin.json` | Plugin manifest for Claude Code |
| `README.md` | This file - documentation and quick start |
| `scar-daemon.ts` | Principle matching engine |
| `hooks/SCARGate.hook.ts` | The guard - blocks tool calls |
| `principles/SOUL.md` | Your principles |
| `docs/HOW_IT_WORKS.md` | Technical deep-dive |
| `docs/FUTURE.md` | Future plans (multi-tool support) |

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

## For Non-Coders

Don't know how to code? No problem. Open Claude Code in any folder and paste this:

---

**PASTE THIS:**

```
I don't know how to code. Set up SCARGate for me like this:

1. Put it on my Desktop
   - Clone SCARGate to Desktop/SCARGate
   - If already cloned somewhere else, that's fine, just tell me where

2. Install the stuff it needs
   - Check if Bun is installed (run `bun --version`)
   - If not installed, open bun.sh in my browser so I can install it
   - Once Bun is ready, run `bun install` in the SCARGate folder

3. Make my personal rules file
   - Create a file called `MY_PRINCIPLES.md` in the SCARGate folder
   - Copy the example principles from `principles/SOUL.md` into it
   - This is where I'll put my own rules later (it won't get overwritten on updates)

4. Write down what you did
   - Create `SETUP_LOG.txt` in the SCARGate folder
   - Write: the date, what you installed, and that setup is complete

5. Check it works
   - Run `bun scar-daemon.ts list`
   - You should see P1 through P14 listed
   - If that works, tell me: "SCARGate is ready. Your rules are in Desktop/SCARGate/MY_PRINCIPLES.md"

6. If anything breaks
   Tell me: "Something went wrong. Just say: look in Desktop/SCARGate and help me fix it."
```

---

**What SCARGate does (plain English):**

SCARGate is like a bouncer for your AI. Before your AI does something risky (delete files, push code, change settings), SCARGate checks if it's allowed. If it breaks your rules, it gets blocked and the AI has to ask you first.

**If something goes wrong later:**

Just open Claude Code and say: *"Look in Desktop/SCARGate and help me fix it."*

---

## Contributing

- Issues and PRs welcome
- Tag small tasks with `good first issue`

---

## License

MIT — see [LICENSE](LICENSE)

---

## Credits

Built from the Keystone Personal AI Infrastructure project.

The principles in `principles/SOUL.md` were learned the hard way—by making mistakes and documenting them.
