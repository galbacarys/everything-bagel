# Verbs

The supervisor runs with `--no-builtin-tools`, so its action space is exactly the
typed verbs below, not a shell and not an editor. Each verb is defined in
`src/extension/bagel.ts` and forwarded over the bridge to the bagel process, which
owns all state and authority.

## backlog

Reading, filing, and moving tasks, and claiming one for a run.

- `backlog_list` — list tasks from the tracker, most recently updated first, with
  derived state, blockers, and any live claim. Filter by `states` and `labels`. Use it
  before proposing work.
- `backlog_get` — read one task in full, including its body and any live claim.
- `backlog_create` — file a new task instead of silently expanding the scope of
  existing work. Write what "done" looks like in the body.
- `backlog_transition` — change a task's state: `open`, `claimed`, `in-review`,
  `blocked`, or `done`. `done` closes it; prefer `in-review` while a change is under
  review.
- `backlog_comment` — post a comment for progress a human should see in the tracker,
  such as a posted plan or a review verdict.
- `backlog_claim` — take the claim on a task so another session does not also start it.
  It fails if someone else holds a live claim; that is normal, so pick something else.
  Re-claim to extend the lease.
- `backlog_release` — give up a claim, returning the task to ready. Do this when
  abandoning work rather than leaving a lease to expire.

## notebook

Recording decisions, and searching past ones before re-deriving anything.

- `notebook_append` — append to the engineer's notebook. The notebook is append-only
  and never edited, so record what happened plainly: a decision and its rationale, a
  discovery, something rejected and why, or a verdict. Entries carry a kind
  (`decision`, `work`, `discovery`, `rejected`, `verdict`, `blocker`), an optional
  `taskId`, and optional tags.
- `notebook_search` — search past entries. Use it before re-deriving something,
  especially when a decision might already have been made and reversed.

## plan

Writing a plan, and what approval actually records.

- `plan_write` — write the plan for a task to disk. A plan is a contract, not an
  implementation: say what the outcome is, which files and interfaces change, the
  constraints, and how a human confirms it works. Leave *how* to whoever builds it.
  Writing a plan does not grant permission.
- `plan_read` — read a plan you wrote and whether it has been approved. Approval is
  recorded against the plan itself, so this is the authoritative answer, not your
  memory of the conversation. An unapproved plan cannot be dispatched.
- `plan_list` — list every plan and whether it has been approved.

## gate

Asking a human to decide, and the only two things worth asking about.

- `gate_request` — block until a human answers, then return their decision. Use it for
  exactly two things: choosing which task to start, and approving a plan. Everything
  after a plan is approved is yours to run without asking. Do not use it for progress
  updates; those belong in the notebook.

## dispatch

Starting a worker, steering it, reviewing it, and landing the result.

- `dispatch_start` — start a worker (`implementer`, `reviewer`, or `scout`) in its own
  git worktree, on its own branch, with its own context window. Pass `planSlug` to hand
  it an approved plan, or `task` for a self-contained instruction. It returns as soon
  as the worker is running, so do not block on it; you will receive a brief when it
  finishes.
- `dispatch_status` — list every run this session dispatched, with status, cost, turns,
  and the brief from any that finished. Finished runs also send a brief, so polling is
  not required.
- `dispatch_report` — read a finished run's full report, for when the short brief is not
  enough to decide something.
- `dispatch_steer` — send guidance into a running worker without restarting it. Use it
  to correct or unblock a worker rather than aborting and dispatching again.
- `dispatch_abort` — stop a running worker. Its worktree and branch are kept, so the
  work so far stays recoverable. Prefer steering when a worker is merely going off
  track.
- `dispatch_drop` — remove a finished run's worktree. It refuses when the tree holds
  uncommitted changes or commits not on the base branch, because that work would be
  lost. The branch is kept unless deletion is explicitly requested.
- `dispatch_review` — dispatch an independent reviewer against a finished run's
  worktree. It sees the plan and the staged diff and returns a verdict. Do this before
  landing anything: landing refuses without a PASS. After three rounds without a PASS,
  stop and ask a human.
- `dispatch_land` — commit the reviewed work, push its branch, and open a pull request.
  It refuses unless an independent reviewer returned `VERDICT: PASS`, so this is the
  last step of the loop, not a shortcut past it. The pull request is where the human
  reviews the change.

## Not available

The supervisor has no verb for running shell commands, no verb for editing files, no
verb for pushing directly, and no verb for merging. Those capabilities are absent from
the tool surface, not merely discouraged by a prompt. Landing stops at a pull request:
a human merges it.
