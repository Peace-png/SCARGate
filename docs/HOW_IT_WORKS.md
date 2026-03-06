# How SCARGate Works

## The Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     PRE-TOOL-USE EVENT                          │
│                 (AI is about to run a tool)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SCARGate.hook.ts                           │
│                                                                 │
│  1. Read tool_name and tool_input                              │
│  2. Build context string: "Tool: Bash | Command: rm -rf ..."   │
│  3. Expand with risk patterns (inject trigger words)           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      scar-daemon.ts                             │
│                                                                 │
│  1. Load principles from SOUL.md                               │
│  2. Match context against principle triggers                   │
│  3. Score relevance (0-1+)                                     │
│  4. Return match result with advisory                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SHOULD BLOCK?                                │
│                                                                 │
│  IF relevance >= 0.8                                           │
│  AND level = Critical OR High                                  │
│  AND principle has constraints                                 │
│  THEN → BLOCK with advisory message                            │
│  ELSE → Allow tool to proceed                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     ┌─────────────────┐            ┌─────────────────┐
     │     BLOCKED     │            │    ALLOWED      │
     │                 │            │                 │
     │ Return:         │            │ Return:         │
     │ continue: false │            │ continue: true  │
     │ reason: "..."   │            │                 │
     └─────────────────┘            └─────────────────┘
```

## Risk Pattern Expansion

The key insight: principles are written with INTENT words ("verify", "check"), but actions use ACTION words ("rm", "delete").

SCARGate bridges this gap:

```typescript
// Risk patterns inject intent words when actions are detected
{ pattern: /\b(rm|remove|delete)\s/i, inject: 'delete remove verify check folder path' }
{ pattern: /--force|-f\s/i, inject: 'force verify check' }
{ pattern: /\b(assume|claim|should be)\b/i, inject: 'assume claim verify substrate retrieval' }
```

This means `rm -rf folder` becomes `rm -rf folder delete remove verify check folder path`, which triggers P1 (Verify Before Acting).

## Why 80% Threshold?

Lower threshold = more false positives (blocks things that are fine)
Higher threshold = more false negatives (misses things that should block)

80% is the balance point: confident enough to block, but not trigger-happy.

## Why Only Critical/High Block?

Medium/Low consequence principles are advisory - they remind but don't block.

This prevents the system from becoming annoying. Only serious mistakes get blocked.

## The Advisory Message

When blocked, the AI sees:

```
[SCAR BLOCKED] P1: Always check files before moving...

Why blocked: I broke 11 files by assuming things were fine.

What to do instead:
• List folder contents before any delete operation
• Search for references before moving files
• Ask when uncertain

> "Check the pocket before you throw away the pants."

[Relevance: 90%]
```

This gives context, consequence, and corrective action - not just a blind block.
