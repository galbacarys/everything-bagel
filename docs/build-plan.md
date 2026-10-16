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

## 2. Give the supervisor verbs — *done*

**Risk retired:** that typed tools can replace a shell for the supervisor. They can, and
the supervisor now has no shell at all.

- [x] `src/extension/bagel.ts` — a pi extension registering `backlog_*`, `notebook_*`,
      `plan_write`, `gate_request`, scoped by role. Deliberately self-contained: it
      imports only `typebox` and `node:net`, because pi loads it through jiti from a
      worktree and every cross-file import is one more thing that can fail to resolve.
- [x] `src/ipc/bridge.ts` — a unix-socket bridge, **one connection per request**. That
      costs a syscall and removes reconnection logic, partial-write framing, and stale
      socket state after a bagel restart.
- [x] `src/supervisor/verbs.ts` — the verbs, and therefore the authority. Arguments
      arrive as untrusted JSON from another process, so every one is validated; on
      errors, an unknown verb is reported rather than ignored.
- [x] `src/supervisor/gates.ts` — gates always settle. A forgotten prompt, an aborted
      run, or a disconnected bridge all resolve as declined, so a supervisor cannot hang
      forever on an answer that is not coming.
- [x] `src/supervisor/policy.ts` — the enforcement point. See below.
- [x] Supervisor runs with `--no-extensions -e <extension>` and `--no-builtin-tools`.

### What enforces the action space

The claim "the action space *is* the lifecycle" is now literal, and it rests on three
empirically established facts rather than on a prompt:

- `--no-extensions` disables discovery and the built-in extensions, but an explicit
  `-e <path>` still loads. The child's extensions are therefore exactly ours.
- `--no-builtin-tools` removes `bash`, `edit`, `write`, and `read`.
- `--tools` re-admits named tools — and it is also an allowlist over *extension* tools,
  so the extension's own verb names must be listed or they are registered but inactive.

Final policy: `--no-builtin-tools --tools "read,backlog_*,notebook_*,plan_write,gate_request"`.
The supervisor keeps `read` and nothing else built-in, because planning needs to see the
code and reading is neither mutating nor executing. Denying it would produce worse plans
without making anything safer.

### Why the gate does not use pi's dialogs

The design originally routed approvals through pi's extension-UI subprotocol so that
`ctx.ui.confirm()` would be drawn by bagel. That is not reachable from our client:
`RpcClient` dispatches `extension_ui_request` to event listeners, but its `send` is
private, so there is no way to answer one. A gate built on it would hang.

Routing the gate through the bridge instead is simpler and better: it is one channel
rather than two, the dialog is drawn by the component that owns the screen anyway, and
the pending gate stays in the process that knows whether the asking run is still alive.

**Verified:** `bun test` covers the bridge round trip, unknown verbs, malformed JSON,
handler exceptions, socket-path shortening, handler cancellation when the caller
disappears, and eight gate cases (timeout, abort, double-settle, queue ordering,
shutdown cancellation). 39 tests, 100 assertions. Live: a supervisor session drove
`backlog_get` ×5, `notebook_search` ×3, `read` ×3, `notebook_append`, and `gate_request`,
with **no `bash` at all** — and it noticed from the tracker that #1 was already claimed,
so it recommended #2 instead. That is the claim protocol working across two actors.

**Not in this step:** `dispatch_*`. It needs worktrees and worker lifecycle, which is #2.
The prompt says so explicitly rather than letting the model offer verbs it lacks.

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
trip, expiry, contention, optimistic mutation, and stale-on-failure. `bun run backlog
--slug=cli/cli` reads a real repository: 60 issues with correct derived state and
labels. The claim protocol was also exercised against a live repository end to end:
claim, contest, loser self-cleanup, heartbeat, release, and re-take — 12 checks, with
the repository left exactly as found.

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
