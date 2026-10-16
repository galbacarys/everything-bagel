# Design

Status: **design settled, building v1**. All four blocking questions are resolved
(§11); the build order is in `docs/build-plan.md`.

---

## 1. Thesis

Agentic development tooling today fails in four specific ways, and all four are
architecture problems, not prompt problems:

1. **Context plumbing is manual.** The agent cannot see what you see.
2. **Review is undirected.** A raw diff is a haystack; nobody tells you which three
   hunks actually matter.
3. **Plans live in chat.** They evaporate on compaction.
4. **Nothing survives the session.** Resuming work is archaeology.

The workflow that fixes these has two distinct planes, and conflating them is why
existing tools get muddy:

| Plane | Nature | Backing store | Conflict risk |
|---|---|---|---|
| **Coordination** | shared, online, teammate-visible | issue tracker (`TrackerAdapter`) | high → needs claims |
| **Memory** | personal, append-only, cheap to write | engineer's notebook | none |

`bagel` owns both, plus a third thing neither plane provides: **a screen**.

## 2. The core architectural move

> **Every agent in bagel is a pi RPC session. The supervisor is not a chatbot with a
> shell — it is an agent whose tool surface *is* the software lifecycle.**

This is the whole design. It is what makes bagel opinionated rather than a wrapper.

A general coding agent has `bash`, `read`, `edit`, `write`. That generality is why
workflows drift. The bagel supervisor instead gets typed, schema'd tools for the
verbs the lifecycle actually has:

```
backlog.list(filter)            → Task[]           (read)
backlog.get(id)                 → Task             (read)
backlog.claim(id)               → Claim            (write, gated)
backlog.create(title, body, …)  → Task             (write, gated)
backlog.transition(id, state)   → Task             (write, gated)

plan.write(slug, body)          → Plan
gate.request(kind, payload)     → Approval         (blocking)

dispatch.start(role, task, …)   → AgentRunId       (write, gated)
dispatch.status(runId?)         → AgentRun[]
dispatch.steer(runId, message)  → void
dispatch.abort(runId)           → void

notebook.append(entry)          → JournalEntry
notebook.search(query)          → JournalEntry[]
notebook.recall(limit)          → JournalEntry[]
```

Two consequences worth stating plainly:

- The supervisor *cannot* run `git push` or `rm -rf`. Not because a prompt tells it
  not to, but because those verbs are not in its action space. Convention-based
  workflows enforce this with a written rule and hope the model complies. We enforce
  it with a TypeScript interface.
- Every action is **observable**. The UI is not scraping logs to guess what happened;
  it receives domain events.

## 3. Architecture

```
                        ┌──────────────────────────────────────┐
                        │  bagel  (single TS binary, bun)      │
                        │                                      │
   owns the screen ────▶│  ui/      pi-tui panes: backlog,     │
                        │           supervisor, agents,        │
                        │           notebook, gates            │
                        │                                      │
   domain events ──────▶│  domain/  Task, Claim, AgentRun,     │
                        │           Brief, JournalEntry        │
                        │           (no pi types, no UI types) │
                        │                                      │
   talks to pi ────────▶│  pi/      RpcClient wrappers:        │
                        │           SupervisorSession,         │
                        │           WorkerSession              │
                        │                                      │
   talks to world ─────▶│  tracker/ TrackerAdapter →           │
                        │           GitHubTracker | memory     │
                        │  notebook/ store, search, context    │
                        └───────────┬──────────────────────────┘
                                    │ spawns, one per agent
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
      pi --mode rpc         pi --mode rpc         pi --mode rpc
      supervisor            worker:implementer    worker:reviewer
      cwd = main repo       cwd = worktree A      cwd = worktree A
      tools = domain        tools = read/…/edit   tools = read, bash
                            (narrow, typed)       (read-only)
              │                     │                     │
              └──── bagel pi extension (registers domain tools) ────┘
                            bridge: unix socket → bagel
```

### Module layout

```
src/
  main.ts                 wire up, build panes, run
  config.ts               repo root, state dir, roles, models
  domain/
    types.ts              Task, Claim, Plan, AgentRun, Brief, JournalEntry, Hit
    events.ts             discriminated-union event bus (the UI's only input)
  ui/
    app.ts                root component, pane layout, focus, keybindings
    panes/backlog.ts      list, filter, state, burn-down counts
    panes/supervisor.ts   streaming markdown of the supervisor session + input line
    panes/agents.ts       live worker grid: status, elapsed, cost, last tool
    panes/notebook.ts     tail of the journal, searchable
    gate.ts               approval dialogs (also serves extension_ui_request)
    theme.ts              theme tokens, shared with pi's active theme
  pi/
    rpc.ts                RpcClient lifecycle, framing, backpressure, shutdown
    supervisor.ts         supervisor session: prompt, steer, event → domain events
    worker.ts             worker session: spawn, stream, steer, abort, reap
  extension/
    bagel.ts              the pi extension: registers domain tools, bridges to bagel
  ipc/
    bridge.ts             unix socket server (bagel side) + client (extension side)
  tracker/
    adapter.ts            TrackerAdapter interface
    github.ts             gh CLI / REST implementation
    memory.ts             in-memory implementation for tests
  notebook/
    store.ts              append-only jsonl journal + living docs (markdown)
    search.ts             FTS index over journal + docs
    context.ts            last-N + relevant-M selection for session priming
  supervisor/
    prompt.ts             the supervisor system prompt
    authority.ts          which actions need a gate (see §7)
    lifecycle.ts          the development lifecycle state machine, in code
```

**Discipline:** `domain/` imports nothing. `ui/` never imports from `pi/` or
`tracker/`. The only path from a pi event to a pixel is a domain event. This keeps
the Go-shell port viable.

### The claim protocol

Claims are what make two sessions on the same repository safe, so the mechanism is
worth stating precisely.

A claim is a **marker comment** on the issue plus the `status:in-progress` label:

```
<!-- bagel:claim {"session":"9c1de7b4","runId":"implementer-1","at":1700000000000,"ttlMs":14400000} -->
```

The label makes claims visible to humans in the tracker's own UI. The comment carries
the identity and the lease.

GitHub has no atomic conditional write, so `claim()` is optimistic and resolves by
**read-back**: post the marker, re-read every marker on the issue, and let the earliest
surviving one win. A loser deletes its own comment, so the record stays clean rather
than accumulating contested claims. Ordering uses the comment's server-side
`createdAt` rather than the client clock, which may be skewed, and falls back to
session id so the winner stays deterministic within the same second.

Claims expire after a TTL (four hours by default) and are refreshed by re-stamping the
marker, so an abandoned session cannot hold work forever. An `in-progress` issue with
no live marker displays as `claim expired or unrecorded` rather than silently looking
healthy.

## 4. Domain model

```ts
type TaskId = string;          // tracker-native, e.g. "41"
type RunId  = string;

interface Task {
  id: TaskId;
  title: string;
  body: string;
  state: "open" | "claimed" | "in-review" | "blocked" | "done";
  labels: string[];            // phase:, lane:, status:, type:
  assignee?: string;
  url?: string;
}

interface Claim { taskId: TaskId; session: string; runId?: RunId; acquiredAt: number; ttlMs: number }

interface Plan { slug: string; taskId: TaskId; path: string; body: string; approvedAt?: number }

interface AgentRun {
  id: RunId;
  role: "implementer" | "reviewer" | "scout";
  taskId?: TaskId;
  worktree?: string;
  pid?: number;
  status: "starting" | "running" | "settled" | "failed";
  exitCode?: number;
  turns: number;
  costUsd: number;
  startedAt: number;
  endedAt?: number;
  lastTool?: string;
  lastMessage?: string;        // tail, for the grid
  verdict?: "PASS" | "BLOCK";  // reviewer only
}

/** Surfaced from a worker to the supervisor. Keeps briefs small; the full report stays on disk. */
interface Brief {
  runId: RunId;
  taskId?: TaskId;
  kind: "progress" | "blocker" | "report" | "verdict";
  summary: string;
  at: number;
}

/** The notebook's unit. Append-only: never edited, corrected by a later entry. */
interface JournalEntry {
  id: string;
  at: number;
  actor: "human" | "supervisor" | RunId;
  taskId?: TaskId;
  kind: "session" | "decision" | "work" | "discovery" | "rejected" | "verdict" | "blocker";
  body: string;
  tags: string[];
  supersedes?: string;         // id of an entry this corrects
}
```

`Brief` is the load-bearing idea for keeping the supervisor's context small: workers
produce long reports on disk, but only a structured summary crosses back into the
supervisor's window.

## 5. The screen

```
╭─ bagel ──────────────────────────────────────────────────────────────────────╮
│ backlog                                   │ supervisor                       │
│ ● #41 token refresh fails on expiry       │ > what's next?                   │
│ ● #42 billing proration off by a cent     │ ▌ #41 is ready and unclaimed.    │
│ ○ #43 add /healthz                        │   It's S, and #42 touches the    │
│   blocked: #41                            │   same module. Recommend #41.    │
│                                           │                                  │
│ ready 2   claimed 1   blocked 1           │   ▌ dispatch implementer? [y/N]  │
├───────────────────────────────────────────┼──────────────────────────────────┤
│ agents                                    │ notebook                         │
│ impl #41  ● running   2m14s  $0.04   7 t  │ 14:02  #41 claimed → impl-x7     │
│   ⏺ edit src/auth.ts                      │ 14:09  plan → .bagel/plans/…     │
│ rev  #40  ✓ PASS      1m02s  $0.01   3 t  │ 14:14  ⚠ impl: token cache stale │
│                                           │ 14:22  decision: no retry on 401 │
├───────────────────────────────────────────┴──────────────────────────────────┤
│ ▌ ask the supervisor…                                              ⏎ send    │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Keybindings (draft): `tab` cycle pane focus, `j/k` move, `⏎` open/act,
`d` dispatch, `p` write plan, `g` gate, `s` search notebook, `q` quit,
`ctrl-c` abort the focused run.

## 6. Why an extension *and* a client

The supervisor needs typed domain tools. In pi, tools come from extensions — the RPC
protocol has no "register a tool" command. So a bagel pi extension is mandatory, and
it is **not** throwaway:

- The extension registers the domain tools and, when one is called, forwards a JSON
  request over a unix socket to the bagel process and returns the response.
- bagel stays authoritative: all state, authority checks, and side effects live
  there. The extension is a thin, stateless adapter.
- Because it flows through the **extension-UI subprotocol**, a tool that needs
  approval calls `ctx.ui.confirm()` and *bagel draws the dialog*. Gates and tools
  share one channel.
- The same extension is available to workers with a narrower role scope, so
  `implementer` sees `plan.read` but not `backlog.create`.

Therefore: rendering is the client's job, verbs are the extension's job, and the
socket is the seam. (A `bagel bridge <verb> --json` CLI is an acceptable fallback if
the socket proves fussy; it costs a process spawn per call.)

## 7. Gates and authority — *decided*

**Posture: approve the plan, then autonomy to PR.**

Autonomy is bounded by *task*, not by action class. There are exactly two human
gates in the lifecycle:

- **Gate 1 — task.** The supervisor proposes candidates with a recommendation, or
  takes your direction. Nothing is claimed before this.
- **Gate 2 — plan.** The supervisor writes a plan to disk, presents it, and waits.
  Approval issues a **task-scoped autonomy grant**.

Between Gate 2 and the pull request, no further approval is needed: claim, create
worktrees, dispatch implementers and reviewers, run the review loop, append to the
notebook, open the PR. Gate 3 is the PR itself — you review it as you always would.

Deliberately **not** gated, and why:

| Action | Why it is free |
|---|---|
| `backlog.claim` | Reversible, observable, re-claimable. Gating it adds a round-trip per task and protects nothing. |
| `dispatch.start` / `steer` / `abort` | The plan already authorized the work. Steering is correction, not escalation. |
| `notebook.*` | Private, append-only, no external effect. |
| `plan.write` | A local file. The file *is* the gate. |

**Still gated after Gate 2** — each a hard stop needing a fresh human yes:

- Push to a shared or protected branch, merge, or force-push anything.
- Irreversible shared-state changes: closing issues bagel did not open, deleting
  branches, rewriting tracker history.
- Hand-applying to production. In repos where merging *is* deploying — a git-linked
  migration or deploy pipeline — `merge` is a production action and bagel asks.
- Touching files outside the plan's declared scope list (see §8).

The grant is stored **with the task**, not the session, so it survives reloads and
dies with the task. There is no ambient auto-mode; autonomy is always task-scoped.

## 8. Worker model

- One `pi --mode rpc` child per run. Isolation is deliberate: in-process subagents
  live inside the parent session's extension context, so a reload or compaction
  invalidates that context and orphans them. A child process has its own session,
  context window, and lifetime — which is also what makes live `steer` and `abort`
  possible instead of rewriting a task file and relaunching.
- **Completion = `agent_settled`**, never `agent_end`.
- Each run gets a git worktree branched from `main` (§11).
- Roles are markdown files with YAML frontmatter — `model`, `thinking`, `tools`,
  `skills`, `extensions` — plus a system-prompt body, stored at `<state>/roles/`.
  Hand-editable, diffable, and overridable per repo.
- Cheap models implement; expensive models plan and review. Verified as a real cost
  lever by `jev-router`.
- **Independent review earns its cost.** A separate process, separate context, and a
  separate model catches what the author's own pass cannot, precisely because it did
  not write the code. The reviewer is read-only.
- Worker reports stay on disk (`<state>/runs/<id>/`); only a `Brief` crosses back.

## 9. v1 scope — supervisor + backlog spine

**In**

1. `bagel` launches in a git repo, resolves state dir, builds the four-pane screen.
2. `TrackerAdapter` + `GitHubTracker` (via `gh`) + in-memory adapter for tests.
3. Backlog pane: list, filter by label/state, counts, claim state.
4. Supervisor pane: one long-lived pi RPC session, streaming markdown, input line,
   `steer` on send-while-busy.
5. The bagel pi extension with the domain tools from §2, bridged over a socket.
6. Agents pane: live grid from real RPC events — status, elapsed, cost, turns, last
   tool. `steer` / `abort` from the UI.
7. Notebook: append-only journal (`<state>/notebook/journal.jsonl`), living docs
   (`<state>/notebook/docs/*.md`), FTS search, `recall` primed into the supervisor's
   first turn.
8. Gates at whatever posture §7 lands on.
9. One worked end-to-end path: *ask what's next → claim → write plan → approve →
   dispatch implementer → watch → review verdict → notebook entry*.

**Deliberately out of v1**

| Deferred | Why, and what would trigger it |
|---|---|
| Hit-list review (`hitlist.generate`) | The sharpest idea, but it needs diffs worth ranking. Lands right after the spine. Design is ready: score each hunk with one batched `classify()` call, ordered criteria, ~$0.001/PR. |
| Jev risk gate | Cheap in money, costs latency. Add after workers can actually do risky things. Heuristic prefilter first. |
| Notebook distillation | Living docs start hand-written; automatic rewrite from journal is phase 2. |
| Multi-repo | One repo per instance is decided. Portfolio view is a later product. |
| Editor integration | `$EDITOR` as a jump target only. No nvim RPC in v1. |
| Ambient auto mode | Autonomy is always task-scoped (§7). There is no ambient mode. |
| Deploy-lane serialization | At most one in-flight change may touch migrations or deploy config. Needed once two workers can run concurrently, not before. |

## 10. State layout — *decided*

One repo per bagel instance. All state is personal and outside the working tree, at
`~/.bagel/` (or `$XDG_STATE_HOME/bagel`), keyed by repo identity so it survives
deleting the checkout and never pollutes the tree or your `telescope` searches.

```
~/.bagel/
  projects/
    <repo-id>/                 # slug(remote) + short hash of remote URL or path
      project.json             # repo path, remote, tracker config, roles, scope
      notebook/
        journal.jsonl          # append-only, one JournalEntry per line
        docs/*.md              # living distilled docs, one per subsystem
        index.sqlite           # FTS5 over journal + docs
      plans/
        <slug>.md              # the plan, once approved; the grant lives here too
      runs/
        <run-id>/
          task.md              # exact prompt given to the child
          events.jsonl         # raw pi RPC event stream, for audit and replay
          report.md            # final assistant message
          meta.json            # role, model, worktree, pid, exit, cost, turns
      worktrees/<run-id>/      # git worktrees, deliberately out of tree
  config.json                  # global: default roles, models, tracker creds
```

**Worktrees live outside the repo.** Git allows this, and it means agent work never
appears in your file pickers, `live_grep`, or
`git status` in the main checkout. The tradeoff is that the LSP in your main editor
won't index agent worktrees until you open them explicitly.

## 11. Resolved decisions

| Question | Decision |
|---|---|
| Gate posture | Approve the plan, then task-scoped autonomy to PR |
| Worker isolation | git worktree per task, branched from main. Containers are v2. |
| Scope and state | One repo per instance; state at `~/.bagel/projects/<repo-id>/` |
| Notebook visibility | Personal and local. No merge semantics, so the journal stays a trivial append. |

No open questions remain for v1. The build order is in `docs/build-plan.md`.
