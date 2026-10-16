/**
 * Tracker adapters. The coordination plane is shared and online-first, so the
 * adapter is the seam that keeps the workflow from being shaped by any one
 * tracker's data model. See docs/design.md §3.
 */

import type { Task, TaskId, TaskState } from "../domain/types.ts";

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
  done: "status:done",
  laneProd: "lane:prod",
} as const;

/**
 * In-memory adapter. Used by tests and by `bagel --offline`, and it is what the
 * UI runs against while a real backend is unreachable, so the control room is
 * never dead on arrival.
 */
export class MemoryTracker implements TrackerAdapter {
  readonly name = "memory";
  #tasks = new Map<TaskId, Task>();
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

  /** Seed data for a first run. */
  seed(tasks: Array<NewTask & { state?: TaskState }>): void {
    for (const t of tasks) {
      const id = String(this.#next++);
      this.#tasks.set(id, {
        id,
        title: t.title,
        body: t.body,
        state: t.state ?? "open",
        labels: t.labels ?? [],
      });
    }
  }
}
