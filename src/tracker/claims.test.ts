/**
 * Claim protocol semantics.
 *
 * Exercised against the in-memory adapter, which shares the contract with the GitHub
 * one: at most one live claim survives per task, and an expired claim is free to take.
 * The GitHub adapter's optimistic read-back resolves `claim()` the same way, so these
 * expectations hold for both.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { MemoryTracker } from "./adapter.ts";

afterEach(() => {
  setSystemTime();
});

async function trackerWithTask(): Promise<{ tracker: MemoryTracker; id: string }> {
  const tracker = new MemoryTracker();
  const task = await tracker.create({ title: "a task", body: "body" });
  return { tracker, id: task.id };
}

describe("claims", () => {
  test("claiming takes the task and moves it out of open", async () => {
    const { tracker, id } = await trackerWithTask();
    const outcome = await tracker.claim(id, "session-a");
    expect(outcome.ok).toBe(true);
    expect((await tracker.get(id))?.state).toBe("claimed");
  });

  test("a second session loses and is told who holds it", async () => {
    const { tracker, id } = await trackerWithTask();
    await tracker.claim(id, "session-a");
    const second = await tracker.claim(id, "session-b");
    expect(second.ok).toBe(false);
    expect(second.holder?.session).toBe("session-a");
  });

  test("the same session re-claiming is not a conflict", async () => {
    const { tracker, id } = await trackerWithTask();
    await tracker.claim(id, "session-a");
    expect((await tracker.claim(id, "session-a")).ok).toBe(true);
  });

  test("an expired claim is free to take", async () => {
    const { tracker, id } = await trackerWithTask();
    await tracker.claim(id, "session-a", { ttlMs: 1_000 });
    setSystemTime(new Date(Date.now() + 5_000));
    const second = await tracker.claim(id, "session-b", { ttlMs: 1_000 });
    expect(second.ok).toBe(true);
    expect((await tracker.claims()).map((c) => c.session)).toEqual(["session-b"]);
  });

  test("heartbeat extends a claim; an unknown claim cannot be extended", async () => {
    const { tracker, id } = await trackerWithTask();
    await tracker.claim(id, "session-a", { ttlMs: 1_000 });
    setSystemTime(new Date(Date.now() + 900));
    expect(await tracker.heartbeat(id, "session-a", 60_000)).toBe(true);
    setSystemTime(new Date(Date.now() + 5_000));
    expect((await tracker.claims()).length).toBe(1);
    expect(await tracker.heartbeat(id, "session-zzz")).toBe(false);
  });

  test("release returns the task to open and frees the claim", async () => {
    const { tracker, id } = await trackerWithTask();
    await tracker.claim(id, "session-a");
    await tracker.release(id, "session-a");
    expect(await tracker.claims()).toEqual([]);
    expect((await tracker.get(id))?.state).toBe("open");
    expect((await tracker.claim(id, "session-b")).ok).toBe(true);
  });

  test("release by a non-holder leaves the claim intact", async () => {
    const { tracker, id } = await trackerWithTask();
    await tracker.claim(id, "session-a");
    await tracker.release(id, "session-b");
    expect((await tracker.claims()).map((c) => c.session)).toEqual(["session-a"]);
  });

  test("claims list is scoped to live claims only", async () => {
    const { tracker, id } = await trackerWithTask();
    await tracker.claim(id, "session-a", { ttlMs: 1_000 });
    expect((await tracker.claims()).length).toBe(1);
    setSystemTime(new Date(Date.now() + 60_000));
    expect(await tracker.claims()).toEqual([]);
  });
});
