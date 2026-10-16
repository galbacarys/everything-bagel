/**
 * The verbs bagel answers over the bridge.
 *
 * This is where the supervisor's action space is actually implemented, and therefore
 * where authority lives. The extension cannot do any of this itself; it can only ask.
 * Arguments arrive as untrusted JSON from another process, so every one is validated
 * before it reaches a handler.
 */

import type { Plans } from "../exec/plans.ts";
import type { Roster } from "../exec/roster.ts";
import type { BridgeHandlers } from "../ipc/bridge.ts";
import type { Notebook } from "../notebook/store.ts";
import type { Backlog } from "../tracker/backlog.ts";
import { hasClaims, type ClaimCapable } from "../tracker/adapter.ts";
import type { GateRequest, Role, TaskState } from "../domain/types.ts";
import { toSlug } from "../util/frontmatter.ts";
import type { GateQueue } from "./gates.ts";

export interface VerbContext {
  backlog: Backlog;
  notebook: Notebook;
  roster: Roster;
  /** Plans, and the grants that approving one records. */
  plans: Plans;
  gates: GateQueue;
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

function requiredSlug(args: Record<string, unknown>, key: string): string {
  const raw = requiredString(args, key);
  // A slug becomes a filename and a branch name, so it must not be able to escape its
  // directory or produce an illegal git ref.
  const slug = toSlug(raw, "");
  if (!slug) throw new ArgumentError(`\`${key}\` must contain at least one letter or digit`);
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
      const slug = requiredSlug(args, "slug");
      const body = requiredString(args, "body");
      const taskId = optionalString(args, "taskId");

      const plan = await context.plans.write(slug, taskId, body);

      await notebook.append({
        actor: context.role,
        kind: "work",
        body: `Plan written: ${slug} (awaiting approval)`,
        tags: [...(taskId ? [taskId] : []), "plan"],
        ...(taskId ? { taskId } : {}),
      });

      return { slug: plan.slug, path: plan.path, approved: false };
    },

    "plan.read": async (raw) => {
      const args = asObject(raw);
      const slug = requiredSlug(args, "slug");
      const plan = await context.plans.get(slug);
      if (!plan) throw new ArgumentError(`no plan named \`${slug}\``);
      return {
        slug: plan.slug,
        taskId: plan.taskId,
        body: plan.body,
        path: plan.path,
        approved: plan.approvedAt !== undefined,
        approvedAt: plan.approvedAt,
      };
    },

    "plan.list": async () => {
      const plans = await context.plans.list();
      return {
        plans: plans.map((plan) => ({
          slug: plan.slug,
          taskId: plan.taskId,
          approved: plan.approvedAt !== undefined,
        })),
      };
    },

    "gate.request": async (raw, bridgeContext) => {
      const args = asObject(raw);
      const kind = (optionalString(args, "kind") ?? "plan") as GateRequest["kind"];
      const ref = optionalString(args, "ref");

      const decision = await gates.request(
        {
          kind,
          prompt: requiredString(args, "prompt"),
          accept: optionalString(args, "accept") ?? "approve",
          ...(optionalString(args, "detail") ? { detail: optionalString(args, "detail")! } : {}),
          ...(ref ? { ref } : {}),
        },
        bridgeContext.signal,
      );

      // Approving a plan *is* the grant. Recording it here rather than trusting the
      // supervisor means dispatch can refuse a plan a human never actually saw, however
      // the supervisor chooses to describe the situation afterwards.
      if (decision.accepted && kind === "plan" && ref) {
        try {
          const plan = await context.plans.approve(ref);
          await notebook.append({
            actor: "human",
            kind: "decision",
            body: `Plan \`${plan.slug}\` approved. Task-scoped grant issued.`,
            tags: ["plan", "grant", ...(plan.taskId ? [plan.taskId] : [])],
            ...(plan.taskId ? { taskId: plan.taskId } : {}),
          });
          return { ...decision, granted: plan.slug };
        } catch (error) {
          // Fail closed: an approval that could not be recorded is not an approval.
          return {
            accepted: false,
            note: `a human approved, but the grant could not be recorded (${describe(error)}); do not proceed`,
          };
        }
      }

      return decision;
    },

    "dispatch.review": async (raw) => {
      const args = asObject(raw);
      const runId = requiredString(args, "runId");
      const planSlug = optionalString(args, "planSlug");
      const focus = optionalString(args, "focus");

      const record = await context.roster.review(runId, {
        ...(planSlug ? { planSlug } : {}),
        ...(focus ? { focus } : {}),
      });

      const taskId = record.meta.taskId;
      await notebook.append({
        actor: context.role,
        kind: "work",
        body: `Reviewing ${runId} as ${record.meta.id}`,
        tags: [...(taskId ? [taskId] : []), "review"],
        ...(taskId ? { taskId } : {}),
      });

      return {
        runId: record.meta.id,
        reviewsRun: runId,
        round: context.roster.records.filter((r) => r.meta.reviewsRun === runId).length,
      };
    },

    "dispatch.land": async (raw) => {
      const args = asObject(raw);
      const runId = requiredString(args, "runId");
      const result = await context.roster.land(runId, {
        title: requiredString(args, "title"),
        body: optionalString(args, "body") ?? "",
      });

      const record = context.roster.get(runId);
      const taskId = record?.meta.taskId;
      await notebook.append({
        actor: context.role,
        kind: "verdict",
        body: `Opened ${result.url} from ${runId} on ${result.branch}`,
        tags: [...(taskId ? [taskId] : []), "pr"],
        ...(taskId ? { taskId } : {}),
      });

      return result;
    },

    // -- dispatch -----------------------------------------------------------

    "dispatch.start": async (raw) => {
      const args = asObject(raw);
      const role = (optionalString(args, "role") ?? "implementer") as Role;
      if (role === "supervisor") {
        throw new ArgumentError("the supervisor cannot dispatch itself");
      }

      const task = optionalString(args, "task");
      const planSlug = optionalString(args, "planSlug");
      if (!task && !planSlug) {
        throw new ArgumentError(
          "provide `planSlug` for an approved plan, or `task` for a self-contained instruction",
        );
      }

      const record = await context.roster.start({
        role,
        ...(task ? { task } : {}),
        ...(planSlug ? { planSlug } : {}),
        ...(optionalString(args, "taskId") ? { taskId: optionalString(args, "taskId")! } : {}),
        ...(optionalString(args, "slug") ? { slug: optionalString(args, "slug")! } : {}),
        ...(optionalString(args, "base") ? { base: optionalString(args, "base")! } : {}),
        ...(optionalString(args, "reuseWorktree")
          ? { reuseWorktree: optionalString(args, "reuseWorktree")! }
          : {}),
      });

      const taskId = record.meta.taskId;
      await notebook.append({
        actor: context.role,
        kind: "work",
        body: `Dispatched ${role} as ${record.meta.id} on ${record.meta.branch ?? "a worktree"}`,
        tags: [...(taskId ? [taskId] : []), "dispatch"],
        ...(taskId ? { taskId } : {}),
      });

      return {
        runId: record.meta.id,
        role: record.meta.role,
        branch: record.meta.branch,
        worktree: record.meta.worktree,
        model: record.meta.model,
        thinking: record.meta.thinking,
      };
    },

    "dispatch.status": async (raw) => {
      const args = asObject(raw);
      const runId = optionalString(args, "runId");
      const records = runId
        ? [context.roster.get(runId)].filter((record) => record !== undefined)
        : context.roster.records;
      if (runId && records.length === 0) throw new ArgumentError(`unknown run: ${runId}`);

      return {
        active: context.roster.active.length,
        runs: records.map((record) => ({
          runId: record.meta.id,
          role: record.meta.role,
          taskId: record.meta.taskId,
          status: record.meta.status,
          branch: record.meta.branch,
          worktree: record.meta.worktree,
          model: record.meta.model,
          turns: record.meta.turns,
          costUsd: record.meta.costUsd,
          startedAt: record.meta.startedAt,
          endedAt: record.meta.endedAt,
          verdict: record.meta.verdict,
          lastTool: record.run?.lastTool,
          finished: record.finished,
          // Only the summary crosses back. The full report is one call away.
          brief: record.brief?.summary,
        })),
      };
    },

    "dispatch.report": async (raw) => {
      const args = asObject(raw);
      const runId = requiredString(args, "runId");
      const record = context.roster.get(runId);
      if (!record) throw new ArgumentError(`unknown run: ${runId}`);
      return {
        runId,
        status: record.meta.status,
        report: record.report ?? "(no report yet; the run may still be working)",
        reportPath: record.meta.reportPath,
      };
    },

    "dispatch.steer": async (raw) => {
      const args = asObject(raw);
      await context.roster.steer(requiredString(args, "runId"), requiredString(args, "message"));
      return { ok: true };
    },

    "dispatch.abort": async (raw) => {
      const args = asObject(raw);
      await context.roster.abort(requiredString(args, "runId"));
      return { ok: true };
    },

    "dispatch.drop": async (raw) => {
      const args = asObject(raw);
      const runId = requiredString(args, "runId");
      const force = args["force"] === true;
      const record = context.roster.get(runId);
      const result = await context.roster.drop(runId, {
        force,
        deleteBranch: args["deleteBranch"] === true,
      });
      if (result.removed) {
        await notebook.append({
          actor: context.role,
          kind: "work",
          body: `Removed the worktree for ${runId}${result.branchDeleted ? ` (branch ${result.branchDeleted} deleted)` : ""}`,
          tags: ["dispatch"],
          ...(record?.meta.taskId ? { taskId: record.meta.taskId } : {}),
        });
      }
      return result;
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
