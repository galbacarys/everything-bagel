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

Design is settled; the remaining work is the supervisor's typed verbs, a real
tracker adapter, and worker dispatch. See the build plan.

```sh
bun install
bun start              # the control room
bun run smoke          # headless check that the pi integration works
bun run preview 150 42 # render the UI to stdout at a fixed size
```

State lives outside the working tree, at `~/.bagel/projects/<repo-id>/` (or
`$XDG_STATE_HOME/bagel`), keyed by repository identity.

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
