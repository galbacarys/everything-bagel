/**
 * bagel's pi extension: the supervisor's action space.
 *
 * This file is the reason the workflow is opinionated rather than aspirational. The
 * supervisor runs with `--no-builtin-tools`, so it has no `bash`, no `edit`, no
 * `write` — not because a prompt asks it to behave, but because those verbs are not
 * registered here. What it can do is exactly the development lifecycle.
 *
 * Deliberately **self-contained**: it imports only `typebox`, `node:net`, and types.
 * Pi loads it through jiti from a worktree, so every cross-file import would be one
 * more thing that can fail to resolve. The request/response client is thirty lines;
 * duplicating it here is cheaper than the coupling.
 *
 * Callers act through the bagel process, which owns all state and authority. This
 * extension is a stateless adapter, which is also why the dialogs a gate needs are
 * drawn by bagel rather than by pi's own UI (see the note on `gate_request`).
 */

import { connect } from "node:net";
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BRIDGE_ENV = "BAGEL_BRIDGE";
const ROLE_ENV = "BAGEL_ROLE";

/**
 * Generous, because it has to cover a human answering a gate. The bagel side enforces
 * its own timeout on top of this.
 */
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

type Role = "supervisor" | "implementer" | "reviewer" | "scout";

// ---------------------------------------------------------------------------
// Bridge client
// ---------------------------------------------------------------------------

interface BridgeReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * One request per connection. See `src/ipc/bridge.ts` for why.
 *
 * Rejects rather than returning a sentinel, so pi reports a failed tool result and the
 * model sees the reason instead of a plausible-looking empty success.
 */
function request(verb: string, args: unknown): Promise<unknown> {
  const path = process.env[BRIDGE_ENV];
  if (!path) {
    return Promise.reject(
      new Error(
        "This tool only works inside bagel: the bridge socket is not configured (BAGEL_BRIDGE is unset).",
      ),
    );
  }

  return new Promise<unknown>((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`bagel did not answer \`${verb}\` within ${CALL_TIMEOUT_MS}ms`))),
      CALL_TIMEOUT_MS,
    );

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ verb, args })}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let reply: BridgeReply;
      try {
        reply = JSON.parse(buffer.slice(0, newline)) as BridgeReply;
      } catch {
        finish(() => reject(new Error("bagel sent a malformed reply")));
        return;
      }
      if (reply.ok) finish(() => resolve(reply.result));
      else finish(() => reject(new Error(reply.error ?? `bagel rejected \`${verb}\``)));
    });

    socket.on("error", (error: Error) => {
      finish(() => reject(new Error(`cannot reach the bagel bridge at ${path}: ${error.message}`)));
    });

    socket.on("close", () => {
      finish(() => reject(new Error(`bagel closed the connection before answering \`${verb}\``)));
    });
  });
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

interface TaskView {
  id: string;
  title: string;
  state: string;
  labels: string[];
  blockedBy?: string[];
  url?: string;
  body?: string;
}

interface ClaimView {
  taskId: string;
  session: string;
  holder?: string;
  acquiredAt: number;
  ttlMs: number;
}

const text = (body: string): { type: "text"; text: string }[] => [{ type: "text", text: body }];

function describeTask(task: TaskView, claim?: ClaimView): string {
  const notes: string[] = [];
  if (task.blockedBy?.length) notes.push(`blocked by ${task.blockedBy.map((b) => `#${b}`).join(", ")}`);
  if (claim) notes.push(`held by ${claim.holder ?? claim.session}`);
  return `#${task.id} [${task.state}] ${task.title}${notes.length ? `  (${notes.join("; ")})` : ""}`;
}

function renderTasks(result: unknown): string {
  const view = result as { tasks?: TaskView[]; claims?: ClaimView[] };
  const tasks = view.tasks ?? [];
  if (!tasks.length) return "The backlog is empty.";
  const claims = new Map((view.claims ?? []).map((claim) => [claim.taskId, claim]));
  return tasks.map((task) => describeTask(task, claims.get(task.id))).join("\n");
}

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  verb: string;
  render: (result: unknown) => string;
}

const StateEnum = Type.Union(
  [
    Type.Literal("open"),
    Type.Literal("claimed"),
    Type.Literal("in-review"),
    Type.Literal("blocked"),
    Type.Literal("done"),
  ],
  { description: "Task state." },
);

const ALL_TOOLS: ToolSpec[] = [
  {
    name: "backlog_list",
    label: "List backlog",
    description:
      "List tasks from the repository's issue tracker, most recently updated first. Shows derived state, blockers, and who holds any live claim. Use this before proposing work.",
    parameters: Type.Object({
      states: Type.Optional(Type.Array(StateEnum, { description: "Only these states." })),
      labels: Type.Optional(Type.Array(Type.String(), { description: "Only tasks carrying all of these labels." })),
      limit: Type.Optional(Type.Number({ description: "Maximum tasks to return. Default 40." })),
    }),
    verb: "backlog.list",
    render: renderTasks,
  },
  {
    name: "backlog_get",
    label: "Read a task",
    description: "Read one task in full, including its body and any live claim.",
    parameters: Type.Object({ id: Type.String({ description: "Task id, for example \"41\"." }) }),
    verb: "backlog.get",
    render: (result) => {
      const view = result as { task?: TaskView; claims?: ClaimView[] } | null;
      if (!view?.task) return "No such task.";
      const claim = view.claims?.[0];
      return [
        describeTask(view.task, claim),
        view.task.url ? `url: ${view.task.url}` : "",
        view.task.labels.length ? `labels: ${view.task.labels.join(", ")}` : "",
        "",
        view.task.body || "(no body)",
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  },
  {
    name: "backlog_create",
    label: "Create a task",
    description:
      "File a new task in the tracker. Use this instead of silently expanding the scope of existing work. Include what \"done\" looks like in the body.",
    parameters: Type.Object({
      title: Type.String({ description: "One-line title." }),
      body: Type.String({ description: "What needs doing and how a human confirms it is done." }),
      labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to apply, for example type:feat." })),
    }),
    verb: "backlog.create",
    render: (result) => {
      const task = result as TaskView;
      return `Created #${task.id} [${task.state}]: ${task.title}${task.url ? `\n${task.url}` : ""}`;
    },
  },
  {
    name: "backlog_transition",
    label: "Move a task",
    description:
      "Change a task's state. `done` closes it. Prefer `in-review` while a change is under review, and let a merged pull request close it where the tracker can.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id." }),
      state: StateEnum,
    }),
    verb: "backlog.transition",
    render: (result) => {
      const task = result as TaskView;
      return `#${task.id} is now ${task.state}.`;
    },
  },
  {
    name: "backlog_comment",
    label: "Comment on a task",
    description:
      "Post a comment on a task. Use this for progress that a human should see in the tracker, such as a posted plan or a review verdict.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id." }),
      body: Type.String({ description: "Comment body, in Markdown." }),
    }),
    verb: "backlog.comment",
    render: () => "Comment posted.",
  },
  {
    name: "backlog_claim",
    label: "Claim a task",
    description:
      "Take the claim on a task so another session does not also start it. Fails if someone else holds a live claim; that is normal and means pick something else. Re-claim to extend the lease.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id." }),
      ttlMinutes: Type.Optional(Type.Number({ description: "Lease length in minutes. Default 240." })),
    }),
    verb: "backlog.claim",
    render: (result) => {
      const view = result as { ok: boolean; holder?: ClaimView };
      if (view.ok) return "Claimed.";
      const who = view.holder?.holder ?? view.holder?.session ?? "another session";
      return `LOST: ${who} already holds this task. Do not start it; choose different work.`;
    },
  },
  {
    name: "backlog_release",
    label: "Release a task",
    description: "Give up a claim, returning the task to ready. Do this when abandoning work rather than leaving a lease to expire.",
    parameters: Type.Object({ id: Type.String({ description: "Task id." }) }),
    verb: "backlog.release",
    render: () => "Released.",
  },
  {
    name: "notebook_append",
    label: "Record in the notebook",
    description:
      "Append to the engineer's notebook. It is append-only and never edited, so record what happened plainly: a decision and its rationale, a discovery, something you rejected and why, or a verdict. This is what the next session reads.",
    parameters: Type.Object({
      kind: Type.Union(
        [
          Type.Literal("decision"),
          Type.Literal("work"),
          Type.Literal("discovery"),
          Type.Literal("rejected"),
          Type.Literal("verdict"),
          Type.Literal("blocker"),
        ],
        { description: "What kind of entry this is." },
      ),
      body: Type.String({ description: "The entry. One or two sentences is usually right." }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Free-form tags, for example a task id." })),
      taskId: Type.Optional(Type.String({ description: "Task this relates to." })),
    }),
    verb: "notebook.append",
    render: (result) => {
      const view = result as { entry?: { id: string; kind: string } };
      return `Recorded ${view.entry?.kind ?? "entry"} ${view.entry?.id ?? ""}.`.trim();
    },
  },
  {
    name: "notebook_search",
    label: "Search the notebook",
    description:
      "Search past journal entries. Use this before re-deriving something, especially when a decision might already have been made and reversed.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms." }),
      limit: Type.Optional(Type.Number({ description: "Maximum entries. Default 20." })),
    }),
    verb: "notebook.search",
    render: (result) => {
      const view = result as { entries?: Array<{ at: number; kind: string; body: string; tags: string[] }> };
      const entries = view.entries ?? [];
      if (!entries.length) return "Nothing in the notebook matches that.";
      return entries
        .map((entry) => `${new Date(entry.at).toISOString().slice(0, 16)} [${entry.kind}] ${entry.body}`)
        .join("\n");
    },
  },
  {
    name: "plan_write",
    label: "Write a plan",
    description:
      "Write the plan for a task to disk. A plan is a contract, not an implementation: say what the outcome is, which files and interfaces change, the constraints, and how a human confirms it works. Leave *how* to whoever builds it. Writing a plan does not grant permission — request a gate to have it approved.",
    parameters: Type.Object({
      slug: Type.String({ description: "Short kebab-case name, for example fix-token-refresh." }),
      taskId: Type.Optional(Type.String({ description: "Task this plan is for." })),
      body: Type.String({ description: "The plan, in Markdown." }),
    }),
    verb: "plan.write",
    render: (result) => {
      const view = result as { path?: string };
      return `Plan written to ${view.path ?? "disk"}. It is NOT approved yet: request a gate of kind \"plan\" before doing anything else.`;
    },
  },
  {
    name: "gate_request",
    label: "Ask the human to decide",
    description:
      "Block until a human answers, then return their decision. Use this for exactly two things: choosing which task to start, and approving a plan. Everything after a plan is approved is yours to run without asking. Do not use it for progress updates — those belong in the notebook.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("task"), Type.Literal("plan"), Type.Literal("destructive"), Type.Literal("production")], {
        description: "What is being approved.",
      }),
      prompt: Type.String({ description: "The question, in one line." }),
      accept: Type.String({ description: "Label for the affirmative choice, for example \"approve plan\"." }),
      detail: Type.Optional(Type.String({ description: "Extra context shown under the question." })),
    }),
    verb: "gate.request",
    render: (result) => {
      const view = result as { accepted: boolean; note?: string };
      if (view.accepted) return `APPROVED by the human.${view.note ? ` ${view.note}` : ""}`;
      return `DECLINED by the human.${view.note ? ` ${view.note}` : ""} Stop and wait for new instructions; do not proceed on your own reasoning.`;
    },
  },
  {
    name: "dispatch_start",
    label: "Dispatch a worker",
    description:
      "Start a worker in its own git worktree, on its own branch, with its own context window. Pass `planSlug` to hand it an approved plan, or `task` for a self-contained instruction. Returns as soon as the worker is running, so do not wait on it: plan the next thing, and you will receive a brief when this one finishes.",
    parameters: Type.Object({
      role: Type.Union([Type.Literal("implementer"), Type.Literal("reviewer"), Type.Literal("scout")], {
        description: "What kind of worker.",
      }),
      planSlug: Type.Optional(
        Type.String({ description: "Slug of an approved plan in the plans directory, embedded into the task." }),
      ),
      task: Type.Optional(Type.String({ description: "Self-contained instruction, when there is no plan." })),
      taskId: Type.Optional(Type.String({ description: "Task this run is for." })),
      slug: Type.Optional(Type.String({ description: "Branch-name slug. Defaults to the plan slug or task id." })),
      base: Type.Optional(
        Type.String({ description: "Base ref to branch from. Defaults to the repository default branch." }),
      ),
      reuseWorktree: Type.Optional(
        Type.String({ description: "Continue in an existing run's worktree instead of creating a new one." }),
      ),
    }),
    verb: "dispatch.start",
    render: (result) => {
      const view = result as { runId: string; role: string; branch?: string; worktree?: string; model?: string };
      return [
        `Started ${view.runId} (${view.role}).`,
        view.worktree ? `worktree: ${view.worktree}` : "",
        view.branch ? `branch: ${view.branch}` : "",
        view.model ? `model: ${view.model}` : "",
        "It runs in the background. You will get a brief when it finishes; do not block on it.",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  {
    name: "dispatch_status",
    label: "Check on workers",
    description:
      "List every run this session has dispatched, with status, cost, turns, and the brief from any that finished. Finished runs also send you a brief, so you do not need to poll this.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Just this run. Omit for all of them." })),
    }),
    verb: "dispatch.status",
    render: (result) => {
      const view = result as {
        active: number;
        runs: Array<{
          runId: string;
          role: string;
          taskId?: string;
          status: string;
          turns: number;
          costUsd: number;
          lastTool?: string;
          verdict?: string;
          brief?: string;
        }>;
      };
      if (!view.runs.length) return "No runs have been dispatched.";
      return view.runs
        .map((run) => {
          const head = `${run.runId} ${run.role}${run.taskId ? ` #${run.taskId}` : ""} [${run.status}]${run.verdict ? ` ${run.verdict}` : ""} ${run.turns}t $${run.costUsd.toFixed(4)}${run.lastTool ? ` \u00b7 ${run.lastTool}` : ""}`;
          return run.brief ? `${head}\n${run.brief}` : head;
        })
        .join("\n\n");
    },
  },
  {
    name: "dispatch_report",
    label: "Read a worker's report",
    description:
      "Read a finished run's full report. You already receive a short brief; use this only when the brief is not enough to decide something.",
    parameters: Type.Object({ runId: Type.String({ description: "The run to read." }) }),
    verb: "dispatch.report",
    render: (result) => {
      const view = result as { runId: string; status: string; report: string };
      return `${view.runId} [${view.status}]\n\n${view.report}`;
    },
  },
  {
    name: "dispatch_steer",
    label: "Steer a running worker",
    description:
      "Send guidance into a run that is already working, without restarting it. Use this to correct or unblock a worker rather than aborting and dispatching again.",
    parameters: Type.Object({
      runId: Type.String({ description: "The run to steer." }),
      message: Type.String({ description: "The guidance: the blocker, the decision, and the current state." }),
    }),
    verb: "dispatch.steer",
    render: () => "Steering message delivered.",
  },
  {
    name: "dispatch_abort",
    label: "Abort a worker",
    description:
      "Stop a running worker. Its worktree and branch are kept, so the work so far stays recoverable. Prefer steering when a worker is merely going off track.",
    parameters: Type.Object({ runId: Type.String({ description: "The run to abort." }) }),
    verb: "dispatch.abort",
    render: () => "Abort requested. The worktree and its branch are kept.",
  },
  {
    name: "dispatch_drop",
    label: "Remove a worker's worktree",
    description:
      "Remove a finished run's worktree. Refuses when the tree holds uncommitted changes or commits not on the base branch, because that work would be lost. The branch is kept unless you explicitly ask for it to be deleted.",
    parameters: Type.Object({
      runId: Type.String({ description: "The run whose worktree should go." }),
      force: Type.Optional(Type.Boolean({ description: "Discard uncommitted work. Only when you are certain." })),
      deleteBranch: Type.Optional(Type.Boolean({ description: "Also delete the branch. Defaults to false." })),
    }),
    verb: "dispatch.drop",
    render: (result) => {
      const view = result as {
        removed: boolean;
        reason?: string;
        state?: { changes: string[]; committedAhead: number; branch?: string };
      };
      if (view.removed) {
        return `Worktree removed.${view.state?.branch ? ` Branch ${view.state.branch} kept.` : ""}`;
      }
      return `Refused: ${view.reason ?? "work would be lost"}`;
    },
  },
];

/** Which verbs each role may use. A role that lacks a verb cannot call it at all. */
const ROLE_TOOLS: Record<Role, string[]> = {
  supervisor: [
    "backlog_list",
    "backlog_get",
    "backlog_create",
    "backlog_transition",
    "backlog_comment",
    "backlog_claim",
    "backlog_release",
    "notebook_append",
    "notebook_search",
    "plan_write",
    "gate_request",
    "dispatch_start",
    "dispatch_status",
    "dispatch_report",
    "dispatch_steer",
    "dispatch_abort",
    "dispatch_drop",
  ],
  // Workers record what they learn but do not touch the coordination plane. The
  // supervisor owns the backlog so there is one place decisions are made.
  implementer: ["notebook_append", "notebook_search", "backlog_get"],
  reviewer: ["notebook_append", "notebook_search", "backlog_get", "backlog_list"],
  scout: ["notebook_search", "backlog_list", "backlog_get"],
};

function roleFromEnv(): Role {
  const raw = process.env[ROLE_ENV];
  if (raw === "implementer" || raw === "reviewer" || raw === "scout") return raw;
  return "supervisor";
}

export default function bagelExtension(pi: ExtensionAPI): void {
  const role = roleFromEnv();
  const allowed = new Set(ROLE_TOOLS[role]);
  const registered: string[] = [];

  for (const spec of ALL_TOOLS) {
    if (!allowed.has(spec.name)) continue;
    registered.push(spec.name);
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_toolCallId, params) {
        const result = await request(spec.verb, params);
        // `content` is the whole model-facing result, so it carries the information;
        // `details` would only matter to a renderer.
        return { content: text(spec.render(result)), details: undefined };
      },
    });
  }

  // A slash command that surfaces the action space, so it is obvious from inside a
  // session what this role can and cannot do.
  pi.registerCommand("bagel", {
    description: "Show this bagel role's available verbs",
    handler: async (_args, ctx) => {
      const bridge = process.env[BRIDGE_ENV];
      ctx.ui.notify(
        [
          `role: ${role}`,
          `bridge: ${bridge ?? "not configured"}`,
          `verbs: ${registered.join(", ") || "none"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
