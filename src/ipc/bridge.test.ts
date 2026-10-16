/**
 * Bridge and gate behaviour.
 *
 * The bridge is the seam between two processes, so the properties worth protecting are
 * about failure: a bad request must not take the server down, an unknown verb must be
 * reported rather than ignored, and a gate must always settle — including when the
 * caller disappears, because a supervisor parked forever on a dead gate is worse than
 * one that was told no.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { Bus } from "../domain/events.ts";
import { BridgeServer, resolveSocketPath, type BridgeHandlers } from "./bridge.ts";
import { GateQueue } from "../supervisor/gates.ts";

let dir: string;
let server: BridgeServer | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bagel-bridge-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Send one raw request and return the raw reply text. */
function send(path: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        socket.destroy();
        resolve(buffer.slice(0, buffer.indexOf("\n")));
      }
    });
    socket.on("error", reject);
  });
}

async function start(handlers: BridgeHandlers, onError?: (error: unknown, verb: string | undefined) => void): Promise<string> {
  server = new BridgeServer({ path: join(dir, "bridge.sock"), handlers, ...(onError ? { onError } : {}) });
  await server.listen();
  return server.path;
}

describe("BridgeServer", () => {
  test("round trips a request and its result", async () => {
    const path = await start({
      "echo.thing": async (args) => ({ got: args }),
    });
    const reply = JSON.parse(await send(path, `${JSON.stringify({ id: "r1", verb: "echo.thing", args: { a: 1 } })}\n`));
    expect(reply).toEqual({ id: "r1", ok: true, result: { got: { a: 1 } } });
  });

  test("reports an unknown verb instead of silently succeeding", async () => {
    const path = await start({});
    const reply = JSON.parse(await send(path, `${JSON.stringify({ verb: "nope.nope" })}\n`));
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("unknown verb");
  });

  test("survives malformed JSON without dying", async () => {
    const path = await start({ "echo.thing": async () => "fine" });
    const bad = JSON.parse(await send(path, "this is not json\n"));
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("not JSON");

    // The server is still serving.
    const good = JSON.parse(await send(path, `${JSON.stringify({ verb: "echo.thing" })}\n`));
    expect(good).toEqual({ ok: true, result: "fine" });
  });

  test("turns a thrown handler error into a failed reply, not a crash", async () => {
    const errors: unknown[] = [];
    const path = await start(
      {
        "boom.now": async () => {
          throw new Error("handler exploded");
        },
      },
      (error) => errors.push(error),
    );
    const reply = JSON.parse(await send(path, `${JSON.stringify({ verb: "boom.now" })}\n`));
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("handler exploded");
    expect(errors.length).toBe(1);
  });

  test("shortens a socket path that would exceed the platform limit", () => {
    const long = join("/tmp", "x".repeat(200), "bridge.sock");
    const resolved = resolveSocketPath(long);
    expect(resolved.length).toBeLessThanOrEqual(100);
    // Stable, so a restarted process finds the same socket.
    expect(resolveSocketPath(long)).toBe(resolved);
    expect(resolveSocketPath(join(dir, "bridge.sock"))).toBe(join(dir, "bridge.sock"));
  });

  test("aborts the handler when the caller disappears", async () => {
    let aborted: boolean | undefined;
    let started: (() => void) | undefined;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });

    const path = await start({
      "slow.thing": async (_args, context) => {
        started?.();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
        return "never";
      },
    });

    const socket = connect(path);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb: "slow.thing" })}\n`));
    await begun;
    socket.destroy();
    // Give the server a turn to observe the close.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aborted).toBe(true);
  });
});

describe("GateQueue", () => {
  test("a gate settles when a human answers", async () => {
    const bus = new Bus();
    const queue = new GateQueue({ bus });
    const requested: string[] = [];
    const resolved: boolean[] = [];
    bus.on((event) => {
      if (event.type === "gate.requested") requested.push(event.request.id);
      if (event.type === "gate.resolved") resolved.push(event.accepted);
    });

    const decision = queue.request({ kind: "plan", prompt: "approve?", accept: "approve" });
    const current = queue.current;
    expect(current?.prompt).toBe("approve?");
    expect(queue.count).toBe(1);

    expect(queue.resolve(current!.id, { accepted: true })).toBe(true);
    expect(await decision).toEqual({ accepted: true });

    expect(requested.length).toBe(1);
    expect(resolved).toEqual([true]);
    expect(queue.count).toBe(0);
    expect(queue.current).toBeUndefined();
  });

  test("a gate settles as declined when the asking run is aborted", async () => {
    const queue = new GateQueue({ bus: new Bus() });
    const controller = new AbortController();
    const decision = queue.request({ kind: "task", prompt: "which?", accept: "start" }, controller.signal);

    controller.abort();
    const answer = await decision;
    expect(answer.accepted).toBe(false);
    expect(answer.note).toContain("aborted");
    expect(queue.count).toBe(0);
  });

  test("a gate declined before it is awaited still settles once", async () => {
    const queue = new GateQueue({ bus: new Bus() });
    const controller = new AbortController();
    controller.abort();

    const answer = await queue.request({ kind: "plan", prompt: "x", accept: "y" }, controller.signal);
    expect(answer.accepted).toBe(false);
    expect(queue.count).toBe(0);
  });

  test("settling twice is a no-op, and the first answer wins", async () => {
    const queue = new GateQueue({ bus: new Bus() });
    const decision = queue.request({ kind: "plan", prompt: "x", accept: "y" });
    const id = queue.current!.id;

    expect(queue.resolve(id, { accepted: true })).toBe(true);
    expect(queue.resolve(id, { accepted: false })).toBe(false);
    expect(await decision).toEqual({ accepted: true });
  });

  test("queues several gates and shows the oldest first", async () => {
    const queue = new GateQueue({ bus: new Bus() });
    const first = queue.request({ kind: "task", prompt: "first", accept: "go" });
    const second = queue.request({ kind: "plan", prompt: "second", accept: "go" });

    expect(queue.count).toBe(2);
    expect(queue.current?.prompt).toBe("first");

    queue.resolve(queue.current!.id, { accepted: true });
    expect(queue.current?.prompt).toBe("second");
    queue.resolve(queue.current!.id, { accepted: false });

    expect((await first).accepted).toBe(true);
    expect((await second).accepted).toBe(false);
  });

  test("cancelAll declines everything outstanding", async () => {
    const queue = new GateQueue({ bus: new Bus() });
    const decision = queue.request({ kind: "plan", prompt: "x", accept: "y" });
    queue.cancelAll("shutting down");
    const answer = await decision;
    expect(answer.accepted).toBe(false);
    expect(answer.note).toBe("shutting down");
  });

  test("a gate times out rather than parking forever", async () => {
    const queue = new GateQueue({ bus: new Bus(), timeoutMs: 10 });
    const answer = await queue.request({ kind: "plan", prompt: "x", accept: "y" });
    expect(answer.accepted).toBe(false);
    expect(answer.note).toContain("nobody answered");
  });
});
