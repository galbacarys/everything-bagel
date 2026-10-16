/**
 * The pi worker. Every agent in bagel — the supervisor included — is one of these:
 * a `pi --mode rpc` child process whose event stream is translated into domain
 * events. Nothing above this file knows the RPC protocol exists.
 */

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { Bus } from "../domain/events.ts";
import type { AgentRun, Role } from "../domain/types.ts";

/**
 * The RPC event union is large and versioned. We read a handful of shapes from it
 * and tolerate everything else, so a pi upgrade that adds events cannot break the
 * control room.
 */
type AnyRecord = Record<string, unknown>;

export interface AgentOptions {
  role: Role;
  /** Working directory for the child. For workers this is their worktree. */
  cwd: string;
  bus: Bus;
  taskId?: string;
  worktree?: string;
  runId?: string;
  provider?: string;
  model?: string;
  /** Path to pi's CLI entry point. Omit to let RpcClient search. */
  cliPath?: string;
  /** Pass `--no-session`. Workers are ephemeral; the supervisor is not. */
  ephemeral?: boolean;
  sessionName?: string;
  sessionDir?: string;
  /** Pass `--approve` so project-local extensions and skills can load. */
  trustProjectFiles?: boolean;
  /** Absolute path to a pi extension. Loaded with extension discovery disabled. */
  extension?: string;
  /** Disable built-in tools, so only extension tools and the allowlist remain. */
  noBuiltinTools?: boolean;
  /** Comma-separated allowlist of tool names or patterns to activate. */
  toolAllowlist?: string;
  /** Reasoning effort. */
  thinking?: string;
  /** Appended to the system prompt. */
  appendSystemPrompt?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  /** Every raw protocol event, in order. Used to persist a run's transcript. */
  onRawEvent?: (event: unknown) => void;
}

let runCounter = 0;

function nextRunId(role: Role): string {
  runCounter += 1;
  return `${role}-${Date.now().toString(36)}-${runCounter.toString(36)}`;
}

export class Agent {
  readonly run: AgentRun;
  readonly #client: RpcClient;
  readonly #bus: Bus;
  readonly #onRawEvent: ((event: unknown) => void) | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: AgentOptions) {
    this.#bus = options.bus;
    this.#onRawEvent = options.onRawEvent;

    const args: string[] = [];
    if (options.ephemeral) args.push("--no-session");
    if (options.sessionName) args.push("--name", options.sessionName);
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.trustProjectFiles) args.push("--approve");
    if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
    if (options.thinking) args.push("--thinking", options.thinking);

    // `--no-extensions` turns off discovery and the built-in extensions, but an explicit
    // `-e` path still loads. That combination is what makes the child's action space
    // exactly the bagel verbs rather than whatever happens to be installed.
    if (options.extension) args.push("--no-extensions", "--extension", options.extension);
    // Order matters: this clears the built-ins, then the allowlist re-admits named ones.
    if (options.noBuiltinTools) args.push("--no-builtin-tools");
    if (options.toolAllowlist) args.push("--tools", options.toolAllowlist);

    if (options.extraArgs?.length) args.push(...options.extraArgs);

    this.run = {
      id: options.runId ?? nextRunId(options.role),
      role: options.role,
      status: "starting",
      turns: 0,
      costUsd: 0,
      startedAt: Date.now(),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.worktree ? { worktree: options.worktree } : {}),
      ...(options.model ? { model: options.model } : {}),
    };

    this.#client = new RpcClient({
      cwd: options.cwd,
      args,
      ...(options.cliPath ? { cliPath: options.cliPath } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
  }

  async start(): Promise<void> {
    await this.#client.start();
    this.run.status = "running";
    this.#unsubscribe = this.#client.onEvent((event) => {
      // Log first, so the transcript is complete even if translation throws.
      try {
        this.#onRawEvent?.(event);
      } catch {
        // A logging failure must not derail the run.
      }
      translate(this.run, event, this.#bus);
    });
    this.#bus.emit({ type: "run.started", run: this.run });
  }

  get busy(): boolean {
    return this.run.status === "running";
  }

  async prompt(message: string): Promise<void> {
    await this.#client.prompt(message);
  }

  /** Inject guidance into a run that is already working. */
  async steer(message: string): Promise<void> {
    await this.#client.steer(message);
  }

  /**
   * Queue a message for after the current turn, without interrupting it.
   *
   * The right way to deliver a brief to a supervisor that is mid-thought: steering would
   * cut into what it is doing, and prompting would be rejected while it is busy.
   */
  async followUp(message: string): Promise<void> {
    await this.#client.followUp(message);
  }

  async abort(): Promise<void> {
    await this.#client.abort();
  }

  getStderr(): string {
    return this.#client.getStderr();
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    try {
      await this.#client.stop();
    } catch {
      // Already gone. Not worth surfacing on the way out.
    }
    if (this.run.status === "running" || this.run.status === "starting") {
      this.run.status = "settled";
      this.run.endedAt = Date.now();
      this.#bus.emit({ type: "run.settled", run: this.run });
    }
  }
}

// ---------------------------------------------------------------------------
// RPC event -> domain event
// ---------------------------------------------------------------------------

function translate(run: AgentRun, event: unknown, bus: Bus): void {
  const ev = event as AnyRecord;
  const type = typeof ev["type"] === "string" ? (ev["type"] as string) : "";

  switch (type) {
    case "message_update": {
      const delta = ev["assistantMessageEvent"] as AnyRecord | undefined;
      if (delta?.["type"] === "text_delta" && typeof delta["delta"] === "string") {
        bus.emit({ type: "run.delta", runId: run.id, text: delta["delta"] });
      }
      return;
    }

    case "tool_execution_start": {
      const tool = typeof ev["toolName"] === "string" ? (ev["toolName"] as string) : "tool";
      run.lastTool = tool;
      bus.emit({ type: "run.tool", runId: run.id, tool });
      bus.emit({ type: "run.updated", run });
      return;
    }

    case "message_end": {
      const message = ev["message"] as AnyRecord | undefined;
      if (message?.["role"] !== "assistant") return;
      const usage = message["usage"] as AnyRecord | undefined;
      const cost = usage?.["cost"] as AnyRecord | number | undefined;
      const total = typeof cost === "object" && cost !== null ? cost["total"] : cost;
      if (typeof total === "number") run.costUsd = total;
      const text = messageText(message);
      if (text) {
        run.lastMessage = tailText(text, 600);
        const verdict = /VERDICT:\s*(PASS|BLOCK)/.exec(text);
        if (verdict?.[1]) run.verdict = verdict[1] as "PASS" | "BLOCK";
      }
      bus.emit({ type: "run.updated", run });
      return;
    }

    case "turn_end": {
      run.turns += 1;
      bus.emit({ type: "run.updated", run });
      return;
    }

    case "agent_settled": {
      // The only reliable "pi will not continue automatically" signal. `agent_end`
      // can be followed by retries, compaction, or queued follow-ups.
      run.status = "settled";
      run.endedAt = Date.now();
      bus.emit({ type: "run.settled", run });
      return;
    }

    case "error": {
      run.status = "failed";
      run.endedAt = Date.now();
      const message = typeof ev["message"] === "string" ? (ev["message"] as string) : "unknown error";
      bus.emit({ type: "run.failed", runId: run.id, error: message });
      bus.emit({ type: "run.updated", run });
      return;
    }

    default:
      return;
  }
}

function messageText(message: AnyRecord): string {
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = (part as AnyRecord)?.["text"];
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function tailText(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `…${flat.slice(flat.length - max)}`;
}
