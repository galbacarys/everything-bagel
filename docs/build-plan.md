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

## 4. Dispatch and watch — *done, except the plan path*

**Risk retired:** that bagel can run a second pi process in isolation, and that its output
can be watched, steered, and summarised without flooding the supervisor.

- [x] `src/exec/worktree.ts` — create, inspect, and remove git worktrees under the state
      directory, **outside** the repository so agent work never appears in the main
      checkout, in file pickers, or in search results
- [x] `src/exec/roster.ts` — the dispatch layer: resolve role, create worktree, write the
      task, spawn one `pi --mode rpc` child, record everything
- [x] `src/exec/roles.ts` — role definitions at `<state>/roles/*.md` with frontmatter and
      a built-in default per role. Written once, never overwritten, so an edited role
      survives an upgrade.
- [x] `src/exec/runstore.ts` — `task.md`, `events.jsonl`, `report.md`, `meta.json` per run,
      plus `rollUp()`, which is what makes #9 a pure aggregation
- [x] Agents pane reports live role, task, elapsed, cost, turns, and last tool, with `j`/`k`
      selection and `s` to steer / `x` to abort
- [x] Briefs: the full report stays on disk, a short summary is pushed into the
      supervisor's conversation

### Decisions worth recording

**The task is written before the worker exists.** A run that dies on arrival still has a
`task.md` saying what it was asked to do, and a `meta.json` that appears in cost roll-ups.

**Worktrees are never removed quietly.** `drop()` checks for uncommitted changes and for
commits not on the base branch, and refuses if there are any, because `git worktree
remove` on a dirty tree destroys a worker's unfinished work permanently. The branch is kept
unless deletion is asked for explicitly; an unmerged branch is recoverable, a deleted one
is not.

**Briefs arrive after `run.settled`, not with it.** Settling is the child exiting; the brief
is emitted once the report is written and metadata updated. Anything waiting on the brief
should wait for `run.brief`.

**Delivery adapts to what the supervisor is doing.** A busy supervisor gets `followUp`,
which queues behind the current turn; steering would cut into its thinking and a prompt
would be rejected outright mid-turn. An idle one gets a prompt, so the brief starts a turn
rather than sitting unread.

**Role files override the model tiers.** Vocabulary is two tiers (supervisor, implementer)
as decided, and a role definition may refine its own thinking level without introducing a
third tier in configuration.

**Verified:** `bun run dispatch` runs the whole path headlessly against a live child — 13
checks, all passing: the worker writes inside its worktree, the main checkout is untouched,
the worktree is outside the repository, the task predates the worker, the transcript and
report and metadata all land on disk, and the brief carries the task id and the cost. 67
unit tests cover the pure parts, including roll-up across directories and every way a run
directory can be missing or corrupt.

**Not yet verified end to end:** *approving a plan* producing a worker. Dispatch works when
asked directly; the plan-approval gate that would trigger it is #3. The plumbing is in place
— `dispatch_start` takes a `planSlug` and embeds the plan file — but nothing has yet driven
it from a real approval.

## 5. Close the loop — *done*

**Risk retired:** that the constraints the design rests on are enforced by code rather
then by the supervisor's willingness to follow instructions.

- [x] `src/exec/plans.ts` — plans as markdown with frontmatter, where `approvedAt` *is* the
      grant. Recorded against the plan file, so approval is a visible edit and nothing
      trusts the supervisor's memory of a conversation.
- [x] Dispatch refuses an unapproved plan. This is the mechanical form of "never implement
      without permission", and it is the check that matters most in the whole system.
- [x] `src/exec/gitops.ts` — stage, diff, commit, push, open a pull request.
- [x] `Roster.review()` — an independent reviewer gets the plan and the **staged** diff.
- [x] `Roster.land()` — refuses to open a pull request without `VERDICT: PASS` from a
      reviewer that is not the implementer.
- [x] Review rounds capped at three, counted from disk so a restart cannot reset the loop.
- [x] Notebook entries written from run lifecycle events (dispatch, brief, verdict, PR).

### What is enforced, and where

| Rule | Enforced by |
|---|---|
| No code before a human approves the plan | `Plans.requireApproved`, called in `Roster.start` |
| The supervisor cannot edit files or run commands | `--no-builtin-tools` on the supervisor session |
| A change cannot be reviewed twice forever | `MAX_REVIEW_ROUNDS`, counted from `meta.json` |
| An unreviewed change cannot reach the remote | `Roster.land` requires a passing review |
| Removing a worktree cannot discard work | `removeWorktree` refuses a dirty or ahead tree |
| A gate always settles | `GateQueue` timeout, abort, and shutdown paths |

### Findings

**`pr` is a `gh` subcommand, not a `git` one.** Obvious in hindsight, and the failure was
confusing enough to be worth writing down: `git pr create` reports "git: 'pr' is not a git
command" with a suggestion to use `prune`.

**The reviewer must see the staged diff.** `git diff` on a working tree omits untracked
files, so a brand-new file — exactly the kind of change most worth reviewing — would have
been invisible. Staging happens before review, is reversible, and is what makes the diff
complete.

**The pull request body does not belong in the worktree.** It was being written to
`pr-body.md` inside the tree that was about to be pushed, which would leave an unexplained
file in the change. It goes in the run directory with the rest of the run's artifacts.

**Branch from the remote default, and say when the local one has run ahead.** A pull request
is opened against the remote's default branch, so branching from a local default that is
ahead produces a pull request containing commits nobody asked the change to include. The
base is now resolved to `origin/main` (or `origin/HEAD` when it is set), and startup warns
when the local branch is ahead, because otherwise a worker builds against older code and
the resulting diff is confusing for reasons nothing in it explains.

**Verified:** `bun run loop` runs the whole path in one command against real child
processes — `14/14` checks: the plan is written, dispatch refuses a plan nobody approved and
creates nothing, the gate waits and records a grant on approval, the implementer runs
outside the repository without touching the main checkout, the reviewer returns a verdict,
and landing opens a pull request. 89 unit tests, up from 67, including the git operations
against a real throwaway repository.

**Left open for a human:** the pull request the loop produces. That is Gate 3 in the design,
and it is not something to automate away.

## 6. Then

- Hit lists: rank hunks with one batched classifier call, and open `$EDITOR` on the
  ranked points. The design is in `docs/design.md` §9.
- Risk gate: heuristic prefilter, then a classifier on the ambiguous tail, verdicts
  cached by command shape. Costs are in `docs/platform-notes.md` §3.
- Notebook distillation: rewrite living docs from the journal.
- Container isolation per run.
- Fullscreen alternate-screen mode with mouse (currently main-screen mode).
