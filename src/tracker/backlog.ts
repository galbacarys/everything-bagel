/**
 * The backlog: a cached, coalesced view of the coordination plane.
 *
 * The pane re-renders on every keystroke, so nothing on the render path may await a
 * network call. This class owns the cache, refreshes it on a timer, and publishes
 * domain events. It also keeps the last good snapshot when a refresh fails, because a
 * stale backlog is more useful than an empty one.
 */

import type { Bus } from "../domain/events.ts";
import type { Claim, Task, TaskId, TaskState } from "../domain/types.ts";
import { hasClaims, type NewTask, type TrackerAdapter } from "./adapter.ts";

export interface BacklogOptions {
  adapter: TrackerAdapter;
  bus: Bus;
  /** How often to re-read the tracker. */
  refreshMs?: number;
  /** Maximum tasks to hold. */
  limit?: number;
  /**
   * A permanent caveat about this adapter, e.g. why we fell back to a local one. Shown
   * in the header for as long as the process runs, and never cleared by a successful
   * refresh — the adapter is still not the real thing.
   */
  degradedReason?: string;
}

const DEFAULT_REFRESH_MS = 30_000;
const DEFAULT_LIMIT = 60;

export class Backlog {
  readonly adapter: TrackerAdapter;
  readonly #bus: Bus;
  readonly #refreshMs: number;
  readonly #limit: number;
  #tasks: Task[] = [];
  #claims: Claim[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<void> | undefined;
  #live = false;
  #detail: string | undefined;
  readonly #degradedReason: string | undefined;

  constructor(options: BacklogOptions) {
    this.adapter = options.adapter;
    this.#bus = options.bus;
    this.#refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.#limit = options.limit ?? DEFAULT_LIMIT;
    this.#degradedReason = options.degradedReason;
  }

  get tasks(): readonly Task[] {
    return this.#tasks;
  }

  get claims(): readonly Claim[] {
    return this.#claims;
  }

  /** Whether the last refresh succeeded. */
  get live(): boolean {
    return this.#live;
  }

  /** Why the tracker is not live, when it is not. */
  get detail(): string | undefined {
    return this.#detail;
  }

  get name(): string {
    return this.adapter.name;
  }

  /** Publish the current tracker identity and reachability to the UI. */
  announce(live = this.#live, detail = this.#detail): void {
    const reason = detail ?? this.#degradedReason;
    this.#bus.emit({
      type: "tracker.status",
      trackerName: this.adapter.name,
      live,
      ...(reason ? { detail: reason } : {}),
    });
  }

  /** Initial read plus the refresh timer. Safe to call once. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => void this.refresh(), this.#refreshMs);
      // Never let the refresh timer hold the process open.
      this.#timer.unref?.();
    }
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Coalesced: concurrent callers share a single round trip. */
  refresh(): Promise<void> {
    this.#inFlight ??= this.#runRefresh().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #runRefresh(): Promise<void> {
    try {
      const tasks = await this.adapter.list({ limit: this.#limit });
      const claims = await this.#loadClaims();
      this.#tasks = tasks;
      this.#claims = claims;
      this.#live = true;
      this.#detail = undefined;
      this.#bus.emit({ type: "backlog.updated", tasks, claims });
      this.announce();
    } catch (error) {
      // Keep the previous snapshot: stale data beats a blank pane, and the header
      // says the tracker is unreachable.
      this.#live = false;
      this.#detail = firstLine(error);
      this.#bus.emit({ type: "backlog.unavailable", reason: this.#detail });
      this.announce();
    }
  }

  async #loadClaims(): Promise<Claim[]> {
    if (!hasClaims(this.adapter)) return [];
    try {
      return await this.adapter.claims();
    } catch {
      // Claims are advisory. A failure here must not blank the backlog.
      return [];
    }
  }

  // -- mutations ------------------------------------------------------------
  //
  // Mutations apply locally first and then reconcile, rather than awaiting a re-read.
  // Two reasons: the pane reacts immediately, and a just-written change is visible even
  // if the tracker's own read path is briefly stale.

  async create(task: NewTask): Promise<Task> {
    const created = await this.adapter.create(task);
    this.#applyLocal(created);
    void this.refresh();
    return created;
  }

  async transition(id: TaskId, state: TaskState): Promise<Task> {
    const updated = await this.adapter.transition(id, state);
    this.#applyLocal(updated);
    void this.refresh();
    return updated;
  }

  async comment(id: TaskId, body: string): Promise<void> {
    await this.adapter.comment(id, body);
  }

  /** Fold a known change into the cache and publish it. */
  #applyLocal(task: Task): void {
    const index = this.#tasks.findIndex((existing) => existing.id === task.id);
    const next = [...this.#tasks];
    if (index >= 0) next[index] = task;
    else next.unshift(task);
    this.#tasks = next;
    // A locally-applied change is only true because the tracker accepted it, so the
    // tracker is reachable by definition.
    this.#live = true;
    this.#bus.emit({ type: "backlog.updated", tasks: this.#tasks, claims: this.#claims });
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
