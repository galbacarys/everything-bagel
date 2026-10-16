# everything-bagel

An opinionated agentic development workflow, built around [pi](https://pi.dev) as a
subservient worker and a single binary that owns the screen.

> Named for the googly-eye bagel in *Everything Everywhere All at Once*. Like the
> film, it treats every possible version of the workflow as real, and then
> ruthlessly picks one.

## The idea in one paragraph

`bagel` is a control room. It owns the whole terminal, spawns every agent as a pi
RPC session, and gives the supervisor agent a *narrow, opinionated action space* —
read the backlog, claim work, write a plan, dispatch a worker, record what
happened — instead of a shell. The shared coordination plane is an online issue
tracker (GitHub Issues first, behind an adapter). The personal memory plane is an
append-only engineer's notebook that is searchable and partially auto-injected into
new sessions. You watch work burn down in real time, in one window, with no tmux.

## Status

The control-room shell runs. `bun start` opens four panes — backlog, supervisor,
agents, notebook — in one process that owns the terminal, and drives a `pi --mode
rpc` child whose output streams into the supervisor pane. There is no tmux.

The backlog is the repository's real GitHub Issues, read through `gh`, with claims,
dependencies, and derived state.

Design is settled; the remaining work is the supervisor's typed verbs, worker
dispatch, and the plan-approval loop. See the build plan.

```sh
bun install
bun start              # the control room
bun test               # parsers, claim protocol, gates, worktrees, roll-up
bun run smoke          # headless check that the pi integration works
bun run dispatch       # headless check that a worker runs in its own worktree
bun run backlog        # inspect this repo's tracker from the terminal
bun run preview 150 42 # render the UI to stdout at a fixed size
```

`bun run backlog --seed` creates a starter backlog from the build plan, and
`--slug=owner/name` reads any repository read-only.

State lives outside the working tree, at `~/.bagel/projects/<repo-id>/` (or
`$XDG_STATE_HOME/bagel`), keyed by repository identity.

## The coordination plane

The backlog is the repository's issue tracker, reached through the `gh` CLI, so
bagel never holds a token. Issue labels carry bagel's state vocabulary
(`status:ready`, `status:in-progress`, `status:in-review`, `status:blocked`), and
dependencies are read from `blocked by #12` / `depends on #12` in the body.

Concurrency is handled by **claims**: a claim is a marker comment plus a label, with
a TTL. Because GitHub has no atomic conditional write, taking a claim posts the marker
and then re-reads — the earliest surviving marker wins, and a loser deletes its own
comment. See "The claim protocol" in the design.

When the tracker is unreachable, bagel says why in the header and falls back to an
in-memory backlog rather than showing a blank pane.

## Dispatch

The supervisor does not implement. It dispatches, and reads what comes back.

A dispatch resolves the role, creates a git worktree under the state directory, writes the
task to disk, and only then spawns one `pi --mode rpc` child confined to that worktree.
Writing the task first means a run that dies on arrival still says what it was asked to do.

- Worktrees live **outside** the repository, so agent work never shows up in the main
  checkout's status, in file pickers, or in search results.
- Each run leaves `task.md`, `events.jsonl`, `report.md`, and `meta.json` in
  `<state>/runs/<run-id>/`. Only a short summary — a *brief* — crosses back into the
  supervisor's context; the full report stays on disk.
- `meta.json` carries cost, turns, model, role, and timings, so cost analysis is a pure
  aggregation over those files rather than a separate store.
- Removing a worktree is the one destructive act here, so it refuses when the tree holds
  uncommitted changes or commits not on the base branch, and keeps the branch unless asked
  otherwise.
- Roles are editable markdown at `<state>/roles/*.md` with frontmatter, written on first
  run and never overwritten.

## Docs

- [`docs/design.md`](docs/design.md) — decisions, architecture, scope
- [`docs/build-plan.md`](docs/build-plan.md) — ordered steps, each naming its risk
- [`docs/platform-notes.md`](docs/platform-notes.md) — what pi already gives us, with
  measured classifier costs. Read this before proposing anything that "needs" to be
  built from scratch.

## Decisions so far

| Question | Decision |
|---|---|
| Orchestrator stack | TypeScript + `@earendil-works/pi-tui` + `RpcClient`, `bun build --compile` |
| Screen ownership | One binary owns the entire screen. No tmux. pi's own TUI is never shown. |
| pi's role | Subservient worker process, driven over `--mode rpc` (JSONL) |
| Editor | `$EDITOR` as a jump target for review artifacts, not an integration surface |
| Tracker | GitHub Issues first, behind a `TrackerAdapter` interface. Online-first. |
| Notebook | Append-only journal + living docs, searchable, last-N auto-injected |
| v1 slice | Supervisor + backlog spine |
| Risk gating | Deferred, but designed for. Cheaper than expected — see platform notes. |
