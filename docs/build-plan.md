# Build plan

Ordered so that every step ends in something you can run and look at. Each step
names the risk it retires.

## 1. Boot the control room — *done*

**Risk retired:** that a standalone TypeScript app can own the screen with pi-tui and
drive a `pi --mode rpc` child at the same time. It can.

- [x] Resolve repo identity and state directory (`src/util/paths.ts`)
- [x] Domain model and event bus with no external imports (`src/domain/`)
- [x] `Agent`: `RpcClient` wrapper that translates RPC events into domain events
- [x] Resolve pi's JS CLI entry from our own pinned dependency, and refuse anything
      that is not JavaScript (`RpcClient` runs `node <cliPath>`; `pi` on PATH is a
      shell launcher, so the naive approach fails)
- [x] Four-pane layout with ANSI-aware width handling (`src/ui/layout.ts`)
- [x] Supervisor system prompt (`src/supervisor/prompt.ts`)
- [x] `App` root component: header, grid, input line, focus cycling
- [x] `main.ts`: boot, supervisor session, shutdown, notebook priming
- [x] `scripts/smoke.ts` — headless RPC integration test, CI-able
- [x] `scripts/render-preview.ts` — render the UI to stdout at a fixed size, with a
      width-overflow assertion, so layout can be iterated without a TTY

**Verified:** `bun run smoke` connects to a real pi child, streams a reply, and reads
back the updated `turn_end` totals. `bun start` under a pty renders all four panes,
creates a pi session in the state directory, and streams the supervisor's reply into
its pane with the title switching to `supervisor ●` while it works.

**Known gap, by design:** the supervisor still has pi's default tools. Typed tools are
step 2; until then it can read and run bash like any agent, which is exactly what this
step is meant to make unnecessary.

## 2. Give the supervisor verbs

**Risk retired:** that typed tools can replace a shell for the supervisor.

- [ ] pi extension (`src/extension/bagel.ts`) registering `backlog.*`, `plan.write`,
      `notebook.*`, `dispatch.*`, `gate.request`
- [ ] Unix-socket bridge (`src/ipc/bridge.ts`) so the extension forwards calls to the
      bagel process, which stays authoritative
- [ ] Extension UI subprotocol wired to the gate dialog, so pi can ask and bagel draws
- [ ] Supervisor receives the bagel extension via `-e`, and nothing else

**Done when:** the supervisor can list the backlog and append a journal entry through
tools rather than by guessing, and an approval prompt appears as a bagel dialog.

## 3. Real backlog — *done*

**Risk retired:** that the tracker is genuinely swappable, and that the coordination
plane survives two sessions at once.

- [x] `GitHubTracker` behind the existing `TrackerAdapter` interface, driven through the
      `gh` CLI so authentication stays entirely outside bagel
- [x] `ClaimCapable` as a separate capability, with an optimistic claim that resolves by
      read-back (see "The claim protocol" in the design)
- [x] One API call per refresh: reads are batch operations, never N+1 per issue
- [x] A cached `Backlog` that refreshes on a timer and keeps the last good snapshot when
      a refresh fails, because a stale backlog beats a blank pane
- [x] Dependency conventions (`blocked by #12`, `depends on #12`) resolved inside the
      batch already in hand, so blocked state costs no extra call
- [x] Graceful fallback to the in-memory adapter, with the reason shown in the header
- [x] `bun run backlog` to inspect the tracker, with `--slug=` for any repository and
      `--seed` for a starter backlog

**Verified:** `bun test` covers URL parsing, dependency parsing, the claim marker round
trip, expiry, and contention. `bun run backlog --slug=cli/cli` reads a real repository:
60 issues with correct derived state and labels.

**Still open:** nothing hands a claim to a worker yet, because workers do not exist yet.
Claims are currently display-only.

## 4. Dispatch and watch

- [ ] `Worktree`: create, list, and prune git worktrees under the state directory
- [ ] Worker runs report live status, cost, turns, and last tool into the agents pane
- [ ] `steer` and `abort` bound to keys in the agents pane
- [ ] `Brief`: worker report summary routed back to the supervisor, long report on disk
- [ ] Role configs at `<state>/roles/*.md` with frontmatter

**Done when:** approving a plan results in a worker editing a worktree while you
watch, and you can steer it mid-run.

## 5. Close the loop

- [ ] Plan artifact written and approved (the task-scoped grant)
- [ ] Independent reviewer run, verdict read from the review artifact
- [ ] Review loop capped at three rounds, then escalate
- [ ] Notebook auto-writes from run lifecycle events
- [ ] `recall()` primed into every new supervisor session

**Done when:** the full path runs end to end — ask, claim, plan, approve, dispatch,
review, record.

## 6. Then

- Hit lists: rank hunks with one batched classifier call, and open `$EDITOR` on the
  ranked points. The design is in `docs/design.md` §9.
- Risk gate: heuristic prefilter, then a classifier on the ambiguous tail, verdicts
  cached by command shape. Costs are in `docs/platform-notes.md` §3.
- Notebook distillation: rewrite living docs from the journal.
- Container isolation per run.
- Fullscreen alternate-screen mode with mouse (currently main-screen mode).
