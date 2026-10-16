# Platform notes — what pi gives us

Measured against pi `1.3.0`, read from the `docs/` and `examples/` shipped in the
`@earendil-works/pi-coding-agent` npm package. Everything here is read, not assumed.

This document exists to stop us rebuilding things that already exist. Every claim
below is a reason *not* to write code.

---

## 1. RPC is an officially supported integration surface

`docs/rpc.md`:

> RPC mode runs Pi as a long-lived subprocess controlled through JSON records on
> stdin and stdout. Use it for language-independent integrations, process
> isolation, IDEs, and custom user interfaces.

| Interface | Process boundary | Control model | Best fit |
|---|---|---|---|
| SDK | In process | TypeScript methods/events | Node/Bun hosts wanting full API access |
| RPC | Child process | JSONL commands/responses/events | Other languages, isolation, IDEs, custom clients |

**Consequences for bagel**

- Start with `pi --mode rpc --no-session`.
- Framing is strict JSONL, one JSON object per line, LF-terminated. Read stdout as
  a byte stream and split on LF only — Node's `readline` is *wrong* here because it
  also splits on `U+2028`/`U+2029`, which are legal inside JSON strings.
- Stdout is protocol-only. Diagnostics go to stderr. Never parse stderr as protocol.
- Shutdown = close child stdin; pi disposes the runtime and exits.
- Prefer the exported `RpcClient`, which already handles correlation, typed command
  methods, event delivery, and `promptAndWait()`'s subscribe-before-prompt race.
- **A child process is the unit of isolation.** In-process subagents live inside the
  parent session's extension context, so a session replacement, reload, or compaction
  invalidates that context and orphans or kills them. A child `pi` process has its own
  session, context window, and lifetime, so it survives the parent being replaced — and
  it is what makes live `steer`/`abort` possible instead of rewriting a task file and
  relaunching a process.

### Commands available to us (from `docs/rpc-commands.md`)

`prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`,
`get_messages`, `set_model`, `cycle_model`, `get_available_models`,
`set_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`,
`set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`,
`abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`,
`switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`,
`get_last_assistant_text`, `set_session_name`, `get_commands`.

`steer` is the important one for a supervisor: it lets us inject guidance into a
*running* worker mid-turn without killing it. Without an RPC channel, the only way to
redirect a running worker is to rewrite its task file and relaunch a process.

### The completion signal

- `agent_end` ends one low-level agent run. Retries, overflow recovery, compaction,
  steering, and follow-up work can still follow it.
- **`agent_settled` is the only reliable "pi will not continue automatically" event.**
  Use it for worker completion, never `agent_end`.

`prompt`'s response means the prompt was *accepted*, not completed. Read
`data.disposition`; `"handled"` means no run started and `agent_settled` will never
arrive.

### Extension UI subprotocol

`extension_ui_request` / `extension_ui_response` lets a pi extension raise dialogs
(`select`, `confirm`, `input`, `editor`) and have **our** client draw them. This is
how approval gates live inside pi and still render natively in bagel. TUI-only
extension capabilities degrade outside interactive mode — design for the
keyboard-path subset.

Source: `docs/rpc-extension-ui.md`, `examples/rpc-extension-ui.ts`
(a "custom terminal client with extension dialogs" — i.e. our exact use case).

### Modes we do *not* use

| Mode | Why not |
|---|---|
| Print (`-p`) | Final text only, no progress. Fine for throwaway scripts. |
| JSON (`--mode json`) | Streams events but exits after one run; no later commands. Fine for one-shot workers, insufficient for the supervisor. |
| Interactive | pi owns the screen. We don't want that. |
| SDK (in-process) | Would be tighter, but puts pi's event loop in our render loop. RPC keeps the seam. |

---

## 2. `@earendil-works/pi-tui` is a standalone component system

`docs/tui.md` documents the component library. It is the same engine pi renders
with, and it is a separate package — usable by a standalone client.

- Content: `Text`, `Markdown`, `Image`, `TruncatedText`
- Layout: `Container`, `VStack`, `HStack`, `Box`, `Spacer`
- Input: `Input`, `Editor`
- Selection: `SelectList`, `SettingsList`
- Bounds: `ScrollView`
- Progress: `Loader`, `CancellableLoader`
- Pointer: `MouseRegion`
- Overlays via `ctx.ui.custom({ overlay: true })`; outside pi, the overlay handle
  supports `setHidden()` and focus redirection.

Hard-won details worth not rediscovering:

- Every rendered line must fit the supplied width. Measure **terminal columns**, not
  string length — use `visibleWidth()`, `truncateToWidth()`, `sliceByColumn()`,
  `wrapTextWithAnsi()`.
- Pi resets styling and hyperlinks after every line. Reapply styles per line.
- Components cache render output; call `invalidate()` on state/theme change, then
  `tui.requestRender()`. The TUI coalesces render requests.
- Containers wrapping an `Input`/`Editor` must propagate `focused`, or IME candidate
  windows appear in the wrong place.
- Use the injected theme; `getMarkdownTheme()` matches the active pi theme.
- Cache expensive layout/highlighting by width+content and clear it from `invalidate()`.

> **Rule from the docs:** *"Do not create a second terminal renderer inside an
> extension."* This is why the control room is a **client**, not an extension.
> Extensions contribute *tools and dialogs*; bagel owns rendering.

Reference implementations: `examples/extensions/doom-overlay/` (continuously
rendered overlay), `custom-footer.ts`, `modal-editor.ts`, `widget-placement.ts`,
`overlay-qa-tests.ts`.

---

## 3. Classifier models are a first-class primitive (this is the Jev thing)

`docs/models.md` § *Use classifier models*: classifiers do not chat. They answer
typed questions about JSON state and return probabilities.

```ts
const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
const result = await ctx.modelRegistry.classify(jev, {
  state: { command, cwd, planExcerpt },
  questions: {
    risk: {
      type: "score",
      instructions: "How dangerous is executing this in the user's repository?",
      criteria: ["read-only", "reversible", "needs review", "destructive", "irreversible"],
    },
  },
}, { signal });
```

- Extensions reach them via `ctx.modelRegistry.classify()` with no codemode.
- Codemode scripts reach them via `models.classify()` / `models.getAvailableOfType()`.
- `classify()` answers **multiple questions in one call**, batched.
- Question types: `choice` (label + criteria map), `score` (ordered scale,
  `score` = expected index), `bool` (`probability` of true).
- Some classifiers accept `images` — visual review is available with no chat model.
- At most four concurrent classifier calls per codemode script; `Promise.all()` over
  many items is fine.
- `result.usage` carries tokens and `cost.total` when the service reports them.
- Failures do not throw. Check `stopReason` (`"stop" | "error" | "aborted"`) and
  `errorMessage`.

### Cost: measured, not estimated

Billing is **input-only** — `cost.output` is `0` for every classifier in the
catalog. Volume is therefore purely a function of how many tokens we send.

| Model | $/M input | Context | Notes |
|---|---|---|---|
| `cloudflare/clef-flash` | **0.021** | 16K | cheapest useful |
| `typesafe/jev-1.13`, `typesafe/jev-1.14`, `~typesafe/jev-latest` | 0.042 | 262K | |
| `cloudflare/clef` | 0.042 | 16K | |
| `jaredpalmer/kev-4b` | 0.042 | 8K | local-runnable lineage |
| `microsoft/microsoft-decision-1` | 0.042 | 32K | |
| `scaledown/classify-1` | 0.04 | 1M | big context |
| `openai/gpt-6-luna-decisions` | 0.10 | 1.05M | also judges images |
| `inception/mercury-decide:free`, `respan/span-01-lite:free` | **0** | 65K / 4K | free tiers |

All reachable over the **existing OpenRouter credential**. Direct `typesafe/*`
requires `TYPESAFE_API_KEY` and reports tokens at no cost.

| Scenario | Tokens | Cost |
|---|---|---|
| Gate every bash call: 300/session × 400 tok | 120K | **$0.005** |
| Same with a sloppy 5K-token state | 1.5M | **$0.06** |
| Heuristic prefilter → only mutating commands (~30 calls) | 12K | **$0.0005** |
| Hit list per PR: 25K-token diff, one batched call | 25K | **$0.001** (100 PRs ≈ $0.10) |

**Money is a rounding error. Latency is the real cost** — the docs note that
classifier calls "add latency before the first token of the turn." At ~1s per call,
300 gates ≈ 5 minutes of added wall clock per session.

Therefore the gate design is: **cheap heuristic prefilter → classify only ambiguous
or destructive commands → cache verdicts by command shape.** ~90% volume reduction,
free in both currencies.

A **local llama.cpp decision model** (Julia-1, Laya, Kev, lev, OpenJev — see
`docs/llama-cpp.md`) answers natively over `/v1/systemone` and can run the gate
offline at zero marginal cost. Worth trying, since this is WSL.

### Virtual models / routing

`examples/extensions/jev-router.ts` registers `jev/auto`, which classifies the first
user message (Sol for complex, Terra otherwise) and then switches to a cheap
implementation model after the first successful `edit`/`write`. Route state is
stored on the session branch, so it survives compaction. Useful precedent for
per-role model selection.

---

## 4. pi already ships an extensible tool surface

Extensions can register **tools, commands, keybindings, event handlers, renderers,
themes, CLI flags, and virtual models** via `ExtensionAPI`. This is how bagel's
supervisor gets a narrow action space instead of a shell: a bagel pi extension
registers domain tools (`backlog.list`, `dispatch.start`, `notebook.append`, …) that
bridge back to the bagel process.

`docs/skills.md`, `docs/packages.md`, and `docs/prompt-templates.md` cover
distributing these. `package.json` carries `piConfig` (`configDir`, `name`) and
`bin`, so a fork can rebrand. `pi install npm:<pkg>` resolves package resources.
