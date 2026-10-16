/**
 * The bridge: how a pi extension reaches back into the bagel process.
 *
 * The extension is what gives the supervisor typed verbs, and the verbs have to act on
 * state bagel owns — the backlog cache, the notebook, the plan directory, and the gate
 * the human answers. Rather than duplicate that state in the pi process, the extension
 * forwards each call here and bagel stays authoritative.
 *
 * Protocol: newline-delimited JSON, **one connection per request**. A one-shot
 * connection costs a syscall and removes an entire class of bugs — no reconnection
 * logic, no partial-write framing, no stale socket state after a bagel restart.
 *
 *   ->  {"id":"1","verb":"backlog.list","args":{"limit":20}}
 *   <-  {"id":"1","ok":true,"result":[...]}
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Plans and issue bodies can be long; allow a megabyte before giving up. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * `sun_path` is limited to 108 bytes on Linux. A repo id plus a state directory can
 * approach that, and the failure is an unhelpful EINVAL, so long paths fall back to a
 * short stable name in the temp directory.
 */
const MAX_SOCKET_PATH = 100;

export interface BridgeRequest {
  id?: string;
  verb: string;
  args?: unknown;
}

export interface BridgeResponse {
  id?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BridgeContext {
  /** The verb being handled. */
  verb: string;
  /**
   * Aborted when the requesting client hangs up before a response is sent. A gate that
   * nobody will ever read the answer to should not stay pending.
   */
  signal: AbortSignal;
}

export type BridgeHandler = (args: unknown, context: BridgeContext) => Promise<unknown>;
export type BridgeHandlers = Record<string, BridgeHandler>;

export interface BridgeServerOptions {
  /** Preferred socket path. May be shortened; read `BridgeServer.path` after listening. */
  path: string;
  handlers: BridgeHandlers;
  onError?: (error: unknown, verb: string | undefined) => void;
}

/** Shorten a socket path if it would exceed the platform's limit. */
export function resolveSocketPath(candidate: string): string {
  if (candidate.length <= MAX_SOCKET_PATH) return candidate;
  const hash = createHash("sha256").update(candidate).digest("hex").slice(0, 12);
  return join(tmpdir(), `bagel-${hash}.sock`);
}

export class BridgeServer {
  readonly #requestedPath: string;
  readonly #handlers: BridgeHandlers;
  readonly #onError: ((error: unknown, verb: string | undefined) => void) | undefined;
  #server: Server | undefined;
  #path: string;

  constructor(options: BridgeServerOptions) {
    this.#requestedPath = options.path;
    this.#path = resolveSocketPath(options.path);
    this.#handlers = options.handlers;
    this.#onError = options.onError;
  }

  /** The path actually in use. Pass this to the child as `BAGEL_BRIDGE`. */
  get path(): string {
    return this.#path;
  }

  /** Verbs this server will answer, for diagnostics. */
  get verbs(): string[] {
    return Object.keys(this.#handlers).sort();
  }

  async listen(): Promise<void> {
    this.#path = resolveSocketPath(this.#requestedPath);
    await mkdir(dirname(this.#path), { recursive: true });
    // A socket file left by a crashed process would make listen() fail with EADDRINUSE
    // even though nothing is listening.
    await rm(this.#path, { force: true });

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.#handleConnection(socket));
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        this.#server = server;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#path);
    });

    // The bridge exposes the whole lifecycle, so it must not be world-writable.
    await chmod(this.#path, 0o600).catch(() => undefined);
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(this.#path, { force: true }).catch(() => undefined);
  }

  #handleConnection(socket: Socket): void {
    const controller = new AbortController();
    let buffer = "";
    let settled = false;

    const reply = (response: BridgeResponse): void => {
      if (settled) return;
      settled = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        reply({ ok: false, error: `request exceeded ${MAX_REQUEST_BYTES} bytes` });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void this.#dispatch(line, controller.signal).then(reply);
    });

    // A client that disappears mid-request cancels the work. Without this, a gate whose
    // run was aborted would stay pending forever.
    const abandon = (): void => {
      if (settled) return;
      settled = true;
      controller.abort();
    };
    socket.on("close", abandon);
    socket.on("error", abandon);
  }

  async #dispatch(line: string, signal: AbortSignal): Promise<BridgeResponse> {
    let request: BridgeRequest;
    try {
      request = JSON.parse(line) as BridgeRequest;
    } catch {
      return { ok: false, error: "malformed request: not JSON" };
    }

    const id = typeof request.id === "string" ? request.id : undefined;
    const withId = (response: Omit<BridgeResponse, "id">): BridgeResponse =>
      id ? { id, ...response } : response;

    const verb = typeof request.verb === "string" ? request.verb : "";
    if (!verb) return withId({ ok: false, error: "malformed request: missing verb" });

    const handler = this.#handlers[verb];
    if (!handler) {
      return withId({ ok: false, error: `unknown verb: ${verb}` });
    }

    try {
      const result = await handler(request.args, { verb, signal });
      return withId({ ok: true, result });
    } catch (error) {
      this.#onError?.(error, verb);
      return withId({ ok: false, error: describe(error) });
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
