/**
 * Tracker adapters. The coordination plane is shared and online-first, so the
 * adapter is the seam that keeps the workflow from being shaped by any one
 * tracker's data model. See docs/design.md §3.
 *
 * Claims are a separate capability rather than part of `TrackerAdapter`, because the
 * mechanism is inherently tracker-specific (a marker comment here, a lease row there)
 * while the operations are not.
 */

import type { Claim, Task, TaskId, TaskState } from "../domain/types.ts";

export interface NewTask {
  title: string;
  body: string;
  labels?: string[];
}

export interface TaskFilter {
  states?: TaskState[];
  labels?: string[];
  limit?: number;
}

export interface TrackerAdapter {
  /** Human-readable name, shown in the header. */
  readonly name: string;
  /** Whether the backend is reachable right now. */
  available(): Promise<boolean>;
  list(filter?: TaskFilter): Promise<Task[]>;
  get(id: TaskId): Promise<Task | null>;
  create(task: NewTask): Promise<Task>;
  transition(id: TaskId, state: TaskState): Promise<Task>;
  comment(id: TaskId, body: string): Promise<void>;
}

/** Shared label conventions. Adapters translate these to their own vocabulary. */
export const LABEL = {
  ready: "status:ready",
  inProgress: "status:in-progress",
  inReview: "status:in-review",
  blocked: "status:blocked",
  done: "status:done",
  laneProd: "lane:prod",
} as const;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export const DEFAULT_CLAIM_TTL_MS = 4 * 60 * 60 * 1000;

/** A claim is live until its TTL passes. */
export function isExpired(claim: Claim, now: number = Date.now()): boolean {
  return claim.ttlMs > 0 && claim.acquiredAt + claim.ttlMs < now;
}

export interface ClaimOutcome {
  ok: boolean;
  claim: Claim;
  /** Set when `ok` is false: whoever already holds the task. */
  holder?: Claim;
}

export interface ClaimOptions {
  runId?: string;
  ttlMs?: number;
}

/**
 * Cooperative coordination. A tracker with no atomic conditional write implements
 * this optimistically; the contract is only that at most one live claim survives per
 * task once the operation settles.
 */
export interface ClaimCapable {
  claims(): Promise<Claim[]>;
  claim(id: TaskId, session: string, options?: ClaimOptions): Promise<ClaimOutcome>;
  heartbeat(id: TaskId, session: string, ttlMs?: number): Promise<boolean>;
  release(id: TaskId, session: string): Promise<void>;
}

export function hasClaims(adapter: TrackerAdapter): adapter is TrackerAdapter & ClaimCapable {
  const candidate = adapter as Partial<ClaimCapable>;
  return typeof candidate.claims === "function" && typeof candidate.claim === "function";
}

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

/**
 * In-memory adapter. Used by tests, by `bagel --offline`, and as the fallback when a
 * real backend is unreachable, so the control room is never dead on arrival.
 */
export class MemoryTracker implements TrackerAdapter, ClaimCapable {
  readonly name = "memory";
  #tasks = new Map<TaskId, Task>();
  #claims = new Map<TaskId, Claim>();
  #next = 1;

  async available(): Promise<boolean> {
    return true;
  }

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    let tasks = [...this.#tasks.values()];
    if (filter.states?.length) tasks = tasks.filter((t) => filter.states!.includes(t.state));
    if (filter.labels?.length) {
      tasks = tasks.filter((t) => filter.labels!.every((l) => t.labels.includes(l)));
    }
    tasks.sort((a, b) => Number(a.id) - Number(b.id));
    return filter.limit ? tasks.slice(0, filter.limit) : tasks;
  }

  async get(id: TaskId): Promise<Task | null> {
    return this.#tasks.get(id) ?? null;
  }

  async create(task: NewTask): Promise<Task> {
    const id = String(this.#next++);
    const created: Task = {
      id,
      title: task.title,
      body: task.body,
      state: "open",
      labels: task.labels ?? [],
    };
    this.#tasks.set(id, created);
    return created;
  }

  async transition(id: TaskId, state: TaskState): Promise<Task> {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`no such task: ${id}`);
    const next: Task = { ...task, state };
    this.#tasks.set(id, next);
    return next;
  }

  async comment(id: TaskId, _body: string): Promise<void> {
    if (!this.#tasks.has(id)) throw new Error(`no such task: ${id}`);
  }

  async claims(): Promise<Claim[]> {
    const now = Date.now();
    return [...this.#claims.values()].filter((claim) => !isExpired(claim, now));
  }

  async claim(id: TaskId, session: string, options: ClaimOptions = {}): Promise<ClaimOutcome> {
    const live = (await this.claims()).find((claim) => claim.taskId === id);
    if (live && live.session !== session) {
      const mine: Claim = {
        taskId: id,
        session,
        acquiredAt: Date.now(),
        ttlMs: options.ttlMs ?? DEFAULT_CLAIM_TTL_MS,
        ...(options.runId ? { runId: options.runId } : {}),
      };
      return { ok: false, claim: mine, holder: live };
    }
    const claim: Claim = {
      taskId: id,
      session,
      acquiredAt: Date.now(),
      ttlMs: options.ttlMs ?? DEFAULT_CLAIM_TTL_MS,
      ...(options.runId ? { runId: options.runId } : {}),
    };
    this.#claims.set(id, claim);
    await this.transition(id, "claimed");
    return { ok: true, claim };
  }

  async heartbeat(id: TaskId, session: string, ttlMs?: number): Promise<boolean> {
    const live = (await this.claims()).find((claim) => claim.taskId === id && claim.session === session);
    if (!live) return false;
    this.#claims.set(id, { ...live, acquiredAt: Date.now(), ttlMs: ttlMs ?? live.ttlMs });
    return true;
  }

  async release(id: TaskId, session: string): Promise<void> {
    const live = (await this.claims()).find((claim) => claim.taskId === id && claim.session === session);
    if (!live) return;
    this.#claims.delete(id);
    await this.transition(id, "open");
  }

  /** Replace all tasks. Test and preview helper. */
  seed(tasks: Array<NewTask & { state?: TaskState; blockedBy?: TaskId[] }>): void {
    for (const t of tasks) {
      const id = String(this.#next++);
      this.#tasks.set(id, {
        id,
        title: t.title,
        body: t.body,
        state: t.state ?? "open",
        labels: t.labels ?? [],
        ...(t.blockedBy ? { blockedBy: t.blockedBy } : {}),
      });
    }
  }
}
