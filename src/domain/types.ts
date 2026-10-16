/**
 * The domain model. Deliberately imports nothing.
 *
 * Nothing in here may reference pi, the UI toolkit, or a tracker SDK. The only
 * path from a pi event to a pixel is a domain event (see ./events.ts). That
 * boundary is what keeps the shell replaceable.
 */

export type TaskId = string;
export type RunId = string;
export type EntryId = string;

export type Role = "supervisor" | "implementer" | "reviewer" | "scout";

// ---------------------------------------------------------------------------
// Coordination plane — shared, online, teammate-visible
// ---------------------------------------------------------------------------

export type TaskState = "open" | "claimed" | "in-review" | "blocked" | "done";

export interface Task {
  id: TaskId;
  title: string;
  body: string;
  state: TaskState;
  /** Free-form labels. Conventions like `phase:`, `lane:`, `type:` live here. */
  labels: string[];
  assignee?: string;
  url?: string;
  /** Task ids this task cannot start without. */
  blockedBy?: TaskId[];
}

export interface Claim {
  taskId: TaskId;
  /** Identity of the bagel instance that took the claim. */
  session: string;
  runId?: RunId;
  acquiredAt: number;
  ttlMs: number;
  /** Adapter-specific handle for the claim record, e.g. a comment id. */
  ref?: string;
  /** Human handle of whoever holds it, when the tracker knows. */
  holder?: string;
}

// ---------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------

/**
 * Approval is task-scoped, not action-scoped. Approving a plan issues a grant;
 * the grant dies with the task. `Plan.approvedAt` is the grant.
 */
export interface Plan {
  slug: string;
  taskId: TaskId;
  path: string;
  body: string;
  approvedAt?: number;
}

// ---------------------------------------------------------------------------
// Execution plane — ephemeral, local
// ---------------------------------------------------------------------------

export type RunStatus = "starting" | "running" | "settled" | "failed";

export interface AgentRun {
  id: RunId;
  role: Role;
  taskId?: TaskId;
  /** Absolute path to the worktree this run is confined to. */
  worktree?: string;
  model?: string;
  pid?: number;
  status: RunStatus;
  exitCode?: number | null;
  turns: number;
  costUsd: number;
  startedAt: number;
  endedAt?: number;
  /** Most recent tool name, for the live grid. */
  lastTool?: string;
  /** Tail of the most recent assistant message. Full text stays on disk. */
  lastMessage?: string;
  /** Reviewers only. */
  verdict?: "PASS" | "BLOCK";
}

/**
 * What a worker says back to the supervisor. The full report stays on disk in the
 * run directory; only this crosses back, which is how the supervisor's context stays
 * small across many workers.
 */
export interface Brief {
  runId: RunId;
  taskId?: TaskId;
  kind: "progress" | "blocker" | "report" | "verdict";
  summary: string;
  at: number;
}

// ---------------------------------------------------------------------------
// Memory plane — personal, local, append-only
// ---------------------------------------------------------------------------

export type EntryKind =
  | "session"
  | "decision"
  | "work"
  | "discovery"
  | "rejected"
  | "verdict"
  | "blocker";

export interface JournalEntry {
  id: EntryId;
  at: number;
  actor: "human" | "supervisor" | RunId;
  taskId?: TaskId;
  kind: EntryKind;
  body: string;
  tags: string[];
  /** Id of an earlier entry this one corrects. The journal is never edited. */
  supersedes?: EntryId;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface GateRequest {
  id: string;
  kind: "plan" | "task" | "destructive" | "production";
  prompt: string;
  /** Affirmative label, e.g. "approve plan". */
  accept: string;
  detail?: string;
  /**
   * What is being approved, when that is a concrete thing with a name — a plan slug, for
   * instance. Approving a `plan` gate with a `ref` records the grant against that plan.
   */
  ref?: string;
}
