# Future Considerations

## v2: Adapter Pattern for Multi-Tool Support

**Current limitation:** SCARGate is tightly coupled to Claude Code hooks.

**Future architecture:**
```
Tool Event → Adapter → Normalized Intent → SCAR Core → Result → Adapter → Enforce
```

**Normalized Intent (proposed):**
```typescript
interface NormalizedIntent {
  action: 'delete' | 'write' | 'read' | 'execute' | 'modify';
  target: string;        // file path, command, URL
  riskLevel: 'low' | 'medium' | 'high';
  context: string;       // full context for matching
}
```

**Adapters needed for:**
- MCP servers
- Codex CLI
- Cursor
- Windsurf
- Cline

**When to build:** Only when we have an actual use case requiring multi-tool support.

> "Don't build the bridge until you need to cross the river."

---

## Other Ideas

(Add future enhancement ideas here as they come up)
