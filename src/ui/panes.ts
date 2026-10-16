/**
 * Pane contents. Pure functions of state, so they are trivial to test and cannot
 * start side effects during a render pass.
 */

import { bold, dim, palette } from "./style.ts";
import { spread, tail } from "./layout.ts";
import type { AgentRun, JournalEntry, Task, TaskState } from "../domain/types.ts";

export type PaneId = "backlog" | "supervisor" | "agents" | "notebook";

/** Focus can rest on a pane or on the prompt line. */
export type FocusTarget = PaneId | "prompt";

export interface PaneState {
  tasks: Task[];
  runs: AgentRun[];
  journal: JournalEntry[];
  trackerName: string;
  trackerLive: boolean;
  selectedTask: number;
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
    return [
      dim("No tasks."),
      "",
      dim("The tracker adapter is not wired up yet, so the backlog is empty."),
      dim("Ask the supervisor to create work, or connect a tracker."),
    ];
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
    if (task.blockedBy?.length) {
      lines.push(`     ${dim(`blocked by ${task.blockedBy.map((b) => `#${b}`).join(", ")}`)}`);
    }
  }

  return tail(lines, height);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function agentsContent(state: PaneState, height: number): string[] {
  const workers = state.runs.filter((r) => r.role !== "supervisor");
  if (!workers.length) {
    return [dim("No workers yet."), "", dim("After a plan is approved, the supervisor dispatches")];
  }

  const lines: string[] = [];
  for (const run of workers) {
    const role = run.role === "implementer" ? "impl" : run.role === "reviewer" ? "rev " : "sct ";
    const target = run.taskId ? `#${run.taskId}` : "—";
    const status = statusCell(run);
    const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
    const cost = `$${run.costUsd.toFixed(2)}`;
    lines.push(
      `${dim(role)} ${target.padEnd(5)} ${status} ${dim(elapsed.padStart(6))} ${dim(cost.padStart(6))} ${dim(`${run.turns}t`)}`,
    );
    if (run.lastTool) lines.push(`  ${palette.muted("⏺")} ${dim(run.lastTool)}`);
  }

  return tail(lines, height);
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
  const tracker = state.trackerLive ? palette.ok(state.trackerName) : palette.warn(`${state.trackerName} (offline)`);
  const workers = state.runs.filter((r) => r.role !== "supervisor" && r.status === "running").length;
  const right = workers > 0 ? `${tracker} ${dim("·")} ${palette.accent(`${workers} running`)}` : tracker;
  return spread(left, right, width);
}
