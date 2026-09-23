# dsh-snapcompact

Bitmap-frame context compression plugin for DeepSeek Harness (DSH).

Inspired by [`@oh-my-pi/snapcompact`](https://github.com/can1357/oh-my-pi/tree/main/packages/snapcompact).

Instead of asking an LLM to summarize discarded conversation history in lossy prose, snapcompact serializes the exact conversation and renders the text into dense PNG frames of pixel-font glyphs that vision models read back directly. The entire process is local, fast, and deterministic — no auxiliary LLM API calls, no summarization latency, and zero token-cost overhead beyond the compact bitmap frames.

## Features

- **Local & Deterministic**: High-throughput rasterization using native pixel-font rendering (`@oh-my-pi/pi-natives`).
- **Provider-Aware Shapes**:
  - `anthropic` (`11on16-bw`): 8x13 font on 11px advance, black-and-white.
  - `google` (`8on22-bw`): 8x13 font on 22px pitch, tuned for Gemini vision budget.
  - `openai` (`8on22-bw`): 8x13 font on 22px pitch, sent with `detail: "original"`.
  - `cjk` (`silver16-bw`): Silver TrueType font on 16x16 grid for East Asian (Chinese, Japanese, Korean) text.
- **Structured Transcript Serialization**:
  - `¶user:` user message sections
  - `¶think:` assistant reasoning blocks
  - `¶ai:` assistant message sections
  - `¶call: name(args)//intent` tool calls with parameters
  - `<out>...</out>` formatted tool results with dimmed noise
  - Automatic `FILES` section tracking read and modified files (`(Read)`, `(Write)`, `(RW)`)
- **DSH Attachment Integration**:
  - Renders PNG frames and persists them through `ctx.attachments.saveImages`
  - Fully compatible with DSH session persistence and replay
- **Command & Service Support**:
  - `/snapcompact [--frames <N>] [--shape <name>] [--all]` command for on-demand manual compaction
  - `SnapcompactEngine` implements the standard DSH `CompactionEngine` service
  - Automatic step-pressure compaction on `agent/pre-step`
  - Automatic context-overflow recovery on `agent/request-error`

## Usage

### Commands

In any DSH session chat:

- `/snapcompact` — Archive older history immediately using smart defaults (auto shape, max 8 frames, retains 16% recent tokens in plain text).
- `/snapcompact auto` — Toggle automatic background compaction when the agent is idle.
- `/snapcompact auto on` — Enable automatic idle compaction.
- `/snapcompact auto off` — Disable automatic idle compaction.
- `/snapcompact auto threshold <pct>` — Set context window threshold percentage to trigger idle compaction (default 80%).
- `/snapcompact status` — Display current configuration, threshold, and live session token usage.
- `/snapcompact --frames <N>` — Archive history with custom maximum frame count.
- `/snapcompact --shape <name>` — Archive history with specific font/shape variant (`11on16-bw`, `8on22-bw`, `silver16-bw`).
- `/snapcompact --all` — Archive all eligible history without retaining recent plain text.

### Persistence

Auto-compaction preferences are saved to `~/.dsh/snapcompact-config.json` and persist across sessions and application restarts.

### Programmatic Compaction

```javascript
const snapcompact = ctx.get("snapcompact");
await snapcompact.compactNow(agent, signal);
```
