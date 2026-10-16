/**
 * The verbs bagel answers over the bridge.
 *
 * This is where the supervisor's action space is actually implemented, and therefore
 * where authority lives. The extension cannot do any of this itself; it can only ask.
 * Arguments arrive as untrusted JSON from another process, so every one is validated
 * before it reaches a handler.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeHandlers } from "../ipc/bridge.ts";
import type { Notebook } from "../notebook/store.ts";
import type { Backlog } from "../tracker/backlog.ts";
import { hasClaims, type ClaimCapable } from "../tracker/adapter.ts";
import type { Role, TaskState } from "../domain/types.ts";
import type { GateQueue } from "./gates.ts";

export interface VerbContext {
  backlog: Backlog;
  notebook: Notebook;
  gates: GateQueue;
  /** Directory plans are written to. */
  plansPath: string;
  /** Identity of this bagel instance, recorded on claims and journal entries. */
  session: string;
  role: Role;
}

const TASK_STATES: TaskState[] = ["open", "claimed", "in-review", "blocked", "done"];

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

function asObject(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ArgumentError("arguments must be an object");
  return args as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArgumentError(`\`${key}\` is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ArgumentError(`\`${key}\` must be a string`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ArgumentError(`\`${key}\` must be a number`);
  return value;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ArgumentError(`\`${key}\` must be an array of strings`);
  }
  return value as string[];
}

function requiredState(args: Record<string, unknown>, key: string): TaskState {
  const value = args[key];
  if (typeof value !== "string" || !TASK_STATES.includes(value as TaskState)) {
    throw new ArgumentError(`\`${key}\` must be one of: ${TASK_STATES.join(", ")}`);
  }
  return value as TaskState;
}

/** A slug becomes a filename, so it must not be able to escape the plans directory. */
function safeSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new ArgumentError("`slug` must contain at least one letter or digit");
  return slug;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function buildHandlers(context: VerbContext): BridgeHandlers {
  const { backlog, notebook, gates } = context;

  const claimCapable = (): ClaimCapable => {
    if (!hasClaims(backlog.adapter)) {
      throw new Error("this tracker does not support claims");
    }
    return backlog.adapter;
  };

  return {
    "backlog.list": async (raw) => {
      const args = asObject(raw);
      const states = optionalStringArray(args, "states") as TaskState[] | undefined;
      const labels = optionalStringArray(args, "labels");
      const limit = optionalNumber(args, "limit") ?? 40;

      // Read the tracker rather than only the cache: a supervisor planning against a
      // 30-second-old view could start something already finished.
      await backlog.refresh();

      let tasks = [...backlog.tasks];
      if (states?.length) tasks = tasks.filter((task) => states.includes(task.state));
      if (labels?.length) tasks = tasks.filter((task) => labels.every((l) => task.labels.includes(l)));

      return { tasks: tasks.slice(0, limit), claims: [...backlog.claims], total: tasks.length };
    },

    "backlog.get": async (raw) => {
      const args = asObject(raw);
      const id = requiredString(args, "id");
      const task = await backlog.adapter.get(id);
      if (!task) return null;
      return { task, claims: [...backlog.claims].filter((claim) => claim.taskId === id) };
    },

    "backlog.create": async (raw) => {
      const args = asObject(raw);
      const created = await backlog.create({
        title: requiredString(args, "title"),
        body: optionalString(args, "body") ?? "",
        ...(optionalStringArray(args, "labels") ? { labels: optionalStringArray(args, "labels")! } : {}),
      });
      await notebook.append({
        actor: context.role,
        kind: "work",
        body: `Filed #${created.id}: ${created.title}`,
        tags: [created.id],
        taskId: created.id,
      });
      return created;
    },

    "backlog.transition": async (raw) => {
      const args = asObject(raw);
      const id = requiredString(args, "id");
      const state = requiredState(args, "state");
      const updated = await backlog.transition(id, state);
      await notebook.append({
        actor: context.role,
        kind: state === "done" ? "verdict" : "work",
        body: `#${id} moved to ${state}`,
        tags: [id],
        taskId: id,
      });
      return updated;
    },

    "backlog.comment": async (raw) => {
      const args = asObject(raw);
      await backlog.comment(requiredString(args, "id"), requiredString(args, "body"));
      return { ok: true };
    },

    "backlog.claim": async (raw) => {
      const args = asObject(raw);
      const id = requiredString(args, "id");
      const ttlMinutes = optionalNumber(args, "ttlMinutes");
      const outcome = await claimCapable().claim(id, context.session, {
        ...(ttlMinutes ? { ttlMs: ttlMinutes * 60_000 } : {}),
      });
      await backlog.refresh();
      return outcome;
    },

    "backlog.release": async (raw) => {
      const args = asObject(raw);
      const id = requiredString(args, "id");
      await claimCapable().release(id, context.session);
      await backlog.refresh();
      return { ok: true };
    },

    "notebook.append": async (raw) => {
      const args = asObject(raw);
      const entry = await notebook.append({
        actor: context.role,
        kind: (optionalString(args, "kind") ?? "work") as never,
        body: requiredString(args, "body"),
        ...(optionalStringArray(args, "tags") ? { tags: optionalStringArray(args, "tags")! } : {}),
        ...(optionalString(args, "taskId") ? { taskId: optionalString(args, "taskId")! } : {}),
      });
      return { entry };
    },

    "notebook.search": async (raw) => {
      const args = asObject(raw);
      const entries = await notebook.search(
        requiredString(args, "query"),
        optionalNumber(args, "limit") ?? 20,
      );
      return { entries };
    },

    "notebook.recall": async (raw) => {
      const args = asObject(raw);
      const recent = optionalNumber(args, "recent") ?? 25;
      const terms = optionalString(args, "terms");
      const result = await notebook.recall({ recent, ...(terms ? { terms } : {}) });
      return result;
    },

    "plan.write": async (raw) => {
      const args = asObject(raw);
      const slug = safeSlug(requiredString(args, "slug"));
      const body = requiredString(args, "body");
      const taskId = optionalString(args, "taskId");

      await mkdir(context.plansPath, { recursive: true });
      const path = join(context.plansPath, `${slug}.md`);
      const header = [
        `# ${slug}`,
        "",
        taskId ? `Task: #${taskId}` : "Task: (unspecified)",
        `Written: ${new Date().toISOString()}`,
        "Status: awaiting approval — no code may be touched until a human approves.",
        "",
        "---",
        "",
      ].join("\n");
      await writeFile(path, header + body + "\n", "utf8");

      await notebook.append({
        actor: context.role,
        kind: "work",
        body: `Plan written: ${slug}`,
        tags: [...(taskId ? [taskId] : []), "plan"],
        ...(taskId ? { taskId } : {}),
      });

      return { path, slug };
    },

    "gate.request": async (raw, bridgeContext) => {
      const args = asObject(raw);
      return await gates.request(
        {
          kind: (optionalString(args, "kind") ?? "plan") as never,
          prompt: requiredString(args, "prompt"),
          accept: optionalString(args, "accept") ?? "approve",
          ...(optionalString(args, "detail") ? { detail: optionalString(args, "detail")! } : {}),
        },
        bridgeContext.signal,
      );
    },
  };
}
