/**
 * Pane contents. Pure functions of state, so they are trivial to test and cannot
 * start side effects during a render pass.
 */

import { bold, dim, palette } from "./style.ts";
import { spread, tail } from "./layout.ts";
import type { AgentRun, Claim, JournalEntry, Task, TaskId, TaskState } from "../domain/types.ts";

export type PaneId = "backlog" | "supervisor" | "agents" | "notebook";

/** Focus can rest on a pane or on the prompt line. */
export type FocusTarget = PaneId | "prompt";

export interface PaneState {
  tasks: Task[];
  runs: AgentRun[];
  journal: JournalEntry[];
  /** Live claims, keyed by task id. Empty when the tracker has no claim support. */
  claims: ReadonlyMap<TaskId, Claim>;
  trackerName: string;
  trackerLive: boolean;
  /** Why the tracker is unreachable, when it is. */
  trackerDetail?: string;
  selectedTask: number;
  /** Index into the worker runs, not into `runs`. */
  selectedRun: number;
  focus: FocusTarget;
  /** Set while the supervisor is mid-run, so the input line can say so. */
  supervisorBusy: boolean;
}

const STATE_GLYPH: Record<TaskState, string> = {
  open: "○",
  claimed: "◐",
  "in-review": "◑",
  blocked: "◼",
  done: "●",
};

const STATE_COLOR: Record<TaskState, (text: string) => string> = {
  open: palette.muted,
  claimed: palette.accent,
  "in-review": palette.accentAlt,
  blocked: palette.warn,
  done: palette.ok,
};

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

export function backlogContent(state: PaneState, height: number): string[] {
  const tasks = state.tasks;
  if (!tasks.length) {
    const lines = [
      state.trackerLive ? dim("No open work.") : dim("No tasks (tracker unreachable)."),
      "",
    ];
    if (!state.trackerLive && state.trackerDetail) lines.push(palette.warn(state.trackerDetail));
    lines.push(dim("Ask the supervisor to create work, or file issues on the tracker."));
    return lines;
  }

  const counts = new Map<TaskState, number>();
  for (const task of tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  const summary = (["open", "claimed", "in-review", "blocked", "done"] as TaskState[])
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${STATE_COLOR[s](STATE_GLYPH[s])} ${s} ${counts.get(s)}`)
    .join("   ");

  const lines: string[] = [summary, ""];

  const open = tasks.filter((t) => t.state !== "done");
  const done = tasks.filter((t) => t.state === "done");
  const ordered = [...open, ...done];

  // Resolution needs the whole task set, not just this row, so it is built once.
  const stateById = new Map(tasks.map((task) => [task.id, task.state]));

  const rows = Math.max(0, height - 3);
  const firstVisible = Math.max(0, Math.min(state.selectedTask - rows + 1, ordered.length - rows));
  const slice = ordered.slice(firstVisible, firstVisible + rows);

  for (let i = 0; i < slice.length; i++) {
    const task = slice[i]!;
    const index = firstVisible + i;
    const selected = index === state.selectedTask && state.focus === "backlog";
    const pointer = selected ? palette.accent("▌") : " ";
    const glyph = STATE_COLOR[task.state](STATE_GLYPH[task.state]);
    const title = task.state === "done" ? dim(task.title) : task.title;
    lines.push(`${pointer}${glyph} #${task.id} ${title}`);

    const notes: string[] = [];
    if (task.blockedBy?.length) {
      // A blocker that has landed is history, not a reason this task is stuck. Showing
      // it anyway makes an unblocked task look blocked.
      const unresolved = task.blockedBy.filter((id) => stateById.get(id) !== "done");
      if (unresolved.length) notes.push(`blocked by ${unresolved.map((b) => `#${b}`).join(", ")}`);
    }
    const claim = state.claims.get(task.id);
    if (claim) notes.push(`held by ${claim.holder ?? claim.session}`);
    else if (task.state === "claimed") notes.push("claim expired or unrecorded");
    if (task.assignee) notes.push(`assigned ${task.assignee}`);
    if (notes.length) lines.push(`     ${dim(notes.join("  ·  "))}`);
  }

  return tail(lines, height);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Worker runs, in dispatch order. The supervisor is not a worker. */
export function workerRuns(runs: readonly AgentRun[]): AgentRun[] {
  return runs.filter((run) => run.role !== "supervisor");
}

export function agentsContent(state: PaneState, height: number): string[] {
  const workers = workerRuns(state.runs);
  if (!workers.length) {
    return [
      dim("No workers yet."),
      "",
      dim("Once a plan is approved the supervisor dispatches"),
      dim("one into its own git worktree. Runs appear here"),
      dim("live, and survive this session."),
    ].slice(0, Math.max(1, height));
  }

  const selected = state.focus === "agents" ? state.selectedRun : -1;
  const lines: string[] = [];

  for (let index = 0; index < workers.length; index++) {
    const run = workers[index]!;
    const role = run.role === "implementer" ? "impl" : run.role === "reviewer" ? "rev " : "sct ";
    const target = run.taskId ? `#${run.taskId}` : "—";
    const pointer = index === selected ? palette.accent("▌") : " ";
    const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
    const cost = `$${run.costUsd.toFixed(3)}`;

    lines.push(
      `${pointer}${dim(role)} ${target.padEnd(5)} ${statusCell(run)} ${dim(
        elapsed.padStart(6),
      )} ${dim(cost.padStart(7))} ${dim(`${run.turns}t`)}`,
    );

    // The second line carries whatever is most useful right now: the tool being used
    // while it works, or what it concluded once it stops.
    if (run.status === "running" || run.status === "starting") {
      if (run.lastTool) lines.push(`  ${palette.muted("⏺")} ${dim(run.lastTool)}`);
    } else if (run.lastMessage) {
      lines.push(`  ${dim(firstLine(run.lastMessage))}`);
    }
  }

  const body = tail(lines, Math.max(1, height - (state.focus === "agents" ? 1 : 0)));
  if (state.focus === "agents") {
    body.push(dim("  s steer   x abort   j/k select"));
  }
  return body;
}

function firstLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

function statusCell(run: AgentRun): string {
  if (run.verdict) {
    return run.verdict === "PASS" ? palette.ok("✓ PASS") : palette.err("✗ BLOCK");
  }
  switch (run.status) {
    case "running":
      return palette.accent("● run");
    case "starting":
      return palette.warn("◌ start");
    case "failed":
      return palette.err("✗ fail");
    default:
      return palette.muted("○ done");
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Notebook
// ---------------------------------------------------------------------------

export function notebookContent(state: PaneState, height: number): string[] {
  if (!state.journal.length) {
    return [dim("Journal empty."), "", dim("Decisions, discoveries and verdicts land here as")];
  }
  const lines = state.journal.map((entry) => {
    const time = new Date(entry.at).toTimeString().slice(0, 5);
    const kind = KIND_COLOR[entry.kind]?.(entry.kind) ?? dim(entry.kind);
    return `${dim(time)} ${kind} ${truncateBody(entry.body)}`;
  });
  return tail(lines, height);
}

const KIND_COLOR: Record<string, (text: string) => string> = {
  decision: palette.accentAlt,
  work: palette.muted,
  discovery: palette.accent,
  rejected: palette.warn,
  verdict: palette.ok,
  blocker: palette.err,
  session: palette.faint,
};

function truncateBody(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function headerLine(state: PaneState, width: number, repoId: string, session: string): string {
  const left = `${bold(palette.accent("bagel"))} ${dim(repoId)} ${dim(`· ${session}`)}`;
  // A detail means something is degraded — either the tracker is unreachable, or we
  // fell back to a local one. Either way it should read as a warning, not a success.
  const degraded = state.trackerDetail !== undefined;
  const label = degraded ? `${state.trackerName} — ${state.trackerDetail}` : state.trackerName;
  const tracker = state.trackerLive && !degraded ? palette.ok(label) : palette.warn(label);
  const workers = state.runs.filter((r) => r.role !== "supervisor" && r.status === "running").length;
  const right = workers > 0 ? `${tracker} ${dim("·")} ${palette.accent(`${workers} running`)}` : tracker;
  return spread(left, right, width);
}
