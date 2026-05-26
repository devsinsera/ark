# Claude

Slot reserved for a local Claude API / Anthropic SDK companion inside THB.

Intended scope: a small server inside THB that exposes `/apps/claude`,
takes an `ANTHROPIC_API_KEY` (entered via UI, stored locally), and
provides:
- A scratch chat tile for quick questions while triaging an iPhone
- "Explain this ioreg output" / "Translate this libimobiledevice error"
  prompts hard-wired to relevant context from `/api/device`
- "Summarize this checkra1n log" given a pasted log
- Future: tool-use to actually call THB's other routes on behalf of the
  user

Current state: empty stub.

When implemented:
- `server.ts` — Anthropic SDK calls with prompt-caching enabled
- THB `/apps/claude` route — chat UI
- No keys in git; UI prompts for key on first use, stores in
  localStorage (or asks per-session)
