/**
 * Backlog cache behaviour.
 *
 * The properties worth protecting: a mutation is visible immediately rather than after
 * a round trip, and a failed refresh never blanks the pane.
 */

import { describe, expect, test } from "bun:test";
import { Bus, type DomainEvent } from "../domain/events.ts";
import type { Task, TaskId, TaskState } from "../domain/types.ts";
import { MemoryTracker, type NewTask, type TrackerAdapter } from "./adapter.ts";
import { Backlog } from "./backlog.ts";

/** Subscribe first, so the collector never misses an event. */
function collect(bus: Bus): {
  events: DomainEvent[];
  tasks: () => Task[];
  last: <T extends DomainEvent["type"]>(type: T) => Extract<DomainEvent, { type: T }> | undefined;
} {
  const events: DomainEvent[] = [];
  bus.on((event) => events.push(event));
  return {
    events,
    tasks: () => {
      const updates = events.filter((event) => event.type === "backlog.updated");
      return updates.at(-1)?.tasks ?? [];
    },
    last: (type) => {
      const matching = events.filter((event) => event.type === type);
      return matching.at(-1) as Extract<DomainEvent, { type: typeof type }> | undefined;
    },
  };
}

describe("Backlog", () => {
  test("create is published immediately, without waiting for a refresh", async () => {
    const tracker = new MemoryTracker();
    const bus = new Bus();
    const spy = collect(bus);
    const backlog = new Backlog({ adapter: tracker, bus });

    const created = await backlog.create({ title: "brand new", body: "" });

    expect(spy.tasks().map((t) => t.id)).toContain(created.id);
    expect(backlog.tasks.map((t) => t.id)).toContain(created.id);
  });

  test("transition is published immediately", async () => {
    const tracker = new MemoryTracker();
    const bus = new Bus();
    const spy = collect(bus);
    const backlog = new Backlog({ adapter: tracker, bus });

    const task = await tracker.create({ title: "t", body: "" });
    await backlog.refresh();
    await backlog.transition(task.id, "in-review");

    expect(spy.tasks().find((t) => t.id === task.id)?.state).toBe("in-review");
  });

  test("refresh surfaces live claims alongside tasks", async () => {
    const tracker = new MemoryTracker();
    const bus = new Bus();
    const spy = collect(bus);
    const backlog = new Backlog({ adapter: tracker, bus });

    const task = await tracker.create({ title: "t", body: "" });
    await tracker.claim(task.id, "session-a", { ttlMs: 60_000 });
    await backlog.refresh();

    expect(backlog.claims.map((claim) => claim.session)).toEqual(["session-a"]);
    const update = spy.last("backlog.updated");
    expect(update?.tasks.length).toBe(1);
    expect(update?.claims.length).toBe(1);
  });

  test("a failed refresh keeps the last good snapshot and reports why", async () => {
    const tracker = new MemoryTracker();
    const bus = new Bus();
    const spy = collect(bus);

    const healthy = new Backlog({ adapter: tracker, bus });
    const task = await tracker.create({ title: "survivor", body: "" });
    await healthy.refresh();
    expect(healthy.live).toBe(true);

    const flaky = new Backlog({ adapter: new FailingTracker(), bus });
    await flaky.refresh();

    expect(flaky.live).toBe(false);
    expect(flaky.detail).toContain("tracker is down");
    expect(flaky.tasks).toEqual([]);

    // The healthy backlog is untouched by the other one's failure.
    expect(healthy.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(healthy.live).toBe(true);
    expect(spy.events.filter((event) => event.type === "backlog.unavailable").length).toBe(1);
  });

  test("a permanent caveat survives a successful refresh", async () => {
    const bus = new Bus();
    const spy = collect(bus);
    const backlog = new Backlog({
      adapter: new MemoryTracker(),
      bus,
      degradedReason: "gh is not installed",
    });

    await backlog.refresh();

    const status = spy.last("tracker.status");
    expect(status?.live).toBe(true);
    expect(status?.detail).toBe("gh is not installed");
  });
});

class FailingTracker implements TrackerAdapter {
  readonly name = "failing";
  async available(): Promise<boolean> {
    return false;
  }
  async list(): Promise<Task[]> {
    throw new Error("tracker is down");
  }
  async get(_id: TaskId): Promise<Task | null> {
    return null;
  }
  async create(_task: NewTask): Promise<Task> {
    throw new Error("tracker is down");
  }
  async transition(_id: TaskId, _state: TaskState): Promise<Task> {
    throw new Error("tracker is down");
  }
  async comment(_id: TaskId, _body: string): Promise<void> {
    throw new Error("tracker is down");
  }
}
