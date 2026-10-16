/**
 * The roster: bagel's dispatch layer, and the only place worker processes are created.
 *
 * A dispatch does five things, in this order, because the order is what keeps it safe:
 *
 *   1. resolve the role definition,
 *   2. create an isolated worktree,
 *   3. write the task to disk before the worker exists,
 *   4. spawn one `pi --mode rpc` child confined to that worktree,
 *   5. record everything, so the run can be explained and costed afterwards.
 *
 * Writing the task before spawning is deliberate: a run that dies immediately still has
 * a directory that says what it was asked to do.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelChoice, ModelTier } from "../config.ts";
import { tierFor } from "../config.ts";
import type { Bus } from "../domain/events.ts";
import type { AgentRun, Brief, Role } from "../domain/types.ts";
import { Agent } from "../pi/agent.ts";
import { toolPolicyFor } from "../supervisor/policy.ts";
import type { ProjectPaths } from "../util/paths.ts";
import { loadRole, type RoleDefinition } from "./roles.ts";
import {
  extractFinalText,
  prepareRunDir,
  RunLog,
  writeMeta,
  writeReport,
  writeTask,
  type RunMeta,
} from "./runstore.ts";
import { branchFor, createWorktree, removeWorktree, type RemoveWorktreeResult } from "./worktree.ts";

export interface DispatchRequest {
  role: Role;
  /** Free-form task text. */
  task?: string;
  /** Slug of an approved plan in the plans directory, embedded into the task. */
  planSlug?: string;
  taskId?: string;
  /** Overrides the branch-name slug. */
  slug?: string;
  /** Base ref to branch from. Defaults to the repository's default branch. */
  base?: string;
  /** Continue in an existing worktree instead of creating one. */
  reuseWorktree?: string;
}

export interface RunRecord {
  run: AgentRun;
  meta: RunMeta;
  dir: string;
  agent: Agent;
  log: RunLog;
  /** The final assistant message, pulled from the recorded stream. */
  report?: string;
  brief?: Brief;
  finished: boolean;
}

export interface RosterOptions {
  bus: Bus;
  paths: ProjectPaths;
  /** Identity of this bagel instance, recorded on every run. */
  session: string;
  /** Absolute path to the bagel extension, loaded into every worker. */
  extensionPath?: string;
  piCli?: string;
  models: Record<ModelTier, ModelChoice>;
  /** Called once per finished run with a short summary. */
  onBrief?: (brief: Brief, record: RunRecord) => void;
  /** Called with any run that could not be started. */
  onError?: (error: unknown, request: DispatchRequest) => void;
}

let runSequence = 0;

function nextRunId(role: Role): string {
  runSequence += 1;
  return `${role}-${Date.now().toString(36)}-${runSequence.toString(36)}`;
}

/** Build the exact prompt a worker receives. Exported so it can be asserted on. */
export function buildTaskPrompt(options: {
  role: Role;
  runId: string;
  taskId?: string;
  worktree: string;
  planPath?: string;
  planBody?: string;
  task?: string;
}): string {
  const parts: string[] = [];

  parts.push(
    `You are the ${options.role} for a bagel run.`,
    "",
    "Your working directory IS the worktree root:",
    `  ${options.worktree}`,
    "",
    "Use relative paths for everything inside it. Never reconstruct that absolute path",
    "from memory, and never read or write the main checkout or another run's worktree.",
    "",
  );

  if (options.taskId) parts.push(`Task: #${options.taskId}`, "");

  if (options.planBody) {
    parts.push(
      "## The approved plan",
      "",
      options.planBody.trim(),
      "",
      `(Authoritative copy: ${options.planPath ?? "the plans directory"})`,
      "",
      "Implement exactly this plan. Do not deviate from it and do not add scope. If it is",
      "impossible or self-contradictory, stop and say so with the exact error rather than",
      "improvising a different task.",
      "",
    );
  }

  if (options.task) {
    parts.push("## The task", "", options.task.trim(), "");
  }

  parts.push(
    "## Working rules",
    "",
    "- Work only inside your working directory.",
    "- If the same lookup fails twice, stop and report the blocker with the exact error.",
    "- Run the verification the plan names, and paste its real output. Do not summarise it.",
    "- Do not push, do not open a pull request, and do not apply migrations.",
    "",
    "## Report",
    "",
    "Finish with a short report: files changed; commands run and their results; anything",
    "unfinished or uncertain; blockers.",
  );

  return parts.join("\n");
}

export class Roster {
  readonly #bus: Bus;
  readonly #paths: ProjectPaths;
  readonly #session: string;
  readonly #extensionPath: string | undefined;
  readonly #piCli: string | undefined;
  readonly #models: Record<ModelTier, ModelChoice>;
  readonly #onBrief: ((brief: Brief, record: RunRecord) => void) | undefined;
  readonly #onError: ((error: unknown, request: DispatchRequest) => void) | undefined;
  readonly #records = new Map<string, RunRecord>();
  /** Final assistant text per run, captured from the event stream as it arrives. */
  readonly #reports = new Map<string, string>();
  readonly #unsubscribe: () => void;

  constructor(options: RosterOptions) {
    this.#bus = options.bus;
    this.#paths = options.paths;
    this.#session = options.session;
    this.#extensionPath = options.extensionPath;
    this.#piCli = options.piCli;
    this.#models = options.models;
    this.#onBrief = options.onBrief;
    this.#onError = options.onError;

    // Completion is handled by event, not by awaiting a promise, so a run still finishes
    // its bookkeeping when nobody is waiting on it.
    this.#unsubscribe = this.#bus.on((event) => {
      if (event.type === "run.settled") void this.#finish(event.run.id);
      else if (event.type === "run.failed") void this.#finish(event.runId);
    });
  }

  get records(): RunRecord[] {
    return [...this.#records.values()].sort((a, b) => a.meta.startedAt - b.meta.startedAt);
  }

  get active(): RunRecord[] {
    return this.records.filter((record) => !record.finished);
  }

  get(runId: string): RunRecord | undefined {
    return this.#records.get(runId);
  }

  // -- dispatch -------------------------------------------------------------

  async start(request: DispatchRequest): Promise<RunRecord> {
    const role: Role = request.role === "supervisor" ? "implementer" : request.role;
    const definition = await loadRole(this.#paths.roles, role);
    const runId = nextRunId(role);
    const dir = await prepareRunDir(this.#paths.runs, runId);

    // Resolve the plan before anything is created, so a bad slug fails cheaply.
    let planBody: string | undefined;
    let planPath: string | undefined;
    if (request.planSlug) {
      planPath = join(this.#paths.plans, `${request.planSlug}.md`);
      try {
        planBody = await readFile(planPath, "utf8");
      } catch {
        throw new Error(`no plan at ${planPath}; write it with plan_write before dispatching`);
      }
    }

    const slug = request.slug ?? request.planSlug ?? request.taskId ?? role;
    const branch = branchFor(role, this.#session, slug);

    // A follow-up run continues in the worktree that already holds the earlier edits.
    const worktreePath =
      request.reuseWorktree ??
      (
        await createWorktree({
          repoRoot: this.#paths.repoRoot,
          baseDir: this.#paths.worktrees,
          runId,
          branch,
          ...(request.base ? { base: request.base } : {}),
        })
      ).path;

    const taskPrompt = buildTaskPrompt({
      role,
      runId,
      worktree: worktreePath,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.task ? { task: request.task } : {}),
      ...(planBody ? { planBody } : {}),
      ...(planPath ? { planPath } : {}),
    });
    await writeTask(dir, taskPrompt);

    const log = new RunLog(dir);
    await log.open();
    await log.note(
      `dispatch role=${role} branch=${branch} worktree=${worktreePath} session=${this.#session}`,
    );

    const tier = tierFor(role);
    const tierModel = this.#models[tier];
    const model = definition.model ?? tierModel.model;
    const provider = definition.provider ?? tierModel.provider;
    // The role file wins over the tier, so a role can refine "low" to "medium" without
    // introducing a third tier in configuration.
    const thinking = definition.thinking ?? tierModel.thinking;

    const policy = this.#extensionPath ? toolPolicyFor(role, this.#extensionPath) : undefined;

    const meta: RunMeta = {
      id: runId,
      role,
      session: this.#session,
      status: "starting",
      turns: 0,
      costUsd: 0,
      startedAt: Date.now(),
      worktree: worktreePath,
      branch,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(request.base ? { base: request.base } : {}),
    };

    const agent = new Agent({
      role,
      cwd: worktreePath,
      bus: this.#bus,
      runId,
      ephemeral: true,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      worktree: worktreePath,
      env: {
        ...(this.#extensionPath ? { BAGEL_BRIDGE: join(this.#paths.root, "bridge.sock") } : {}),
        BAGEL_ROLE: role,
        BAGEL_SESSION: this.#session,
      },
      onRawEvent: (event) => {
        // Record first, so the transcript is the authoritative record of the run.
        log.write(event);
        const text = extractFinalText(event);
        // Held in a map rather than on the record: the record cannot exist until the
        // agent does, and the agent needs this callback at construction time.
        if (text) this.#reports.set(runId, text);
      },
      ...(policy ? { extension: policy.extension, noBuiltinTools: policy.noBuiltinTools } : {}),
      ...(policy?.allowlist ? { toolAllowlist: policy.allowlist } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(this.#piCli ? { cliPath: this.#piCli } : {}),
      appendSystemPrompt: definition.instructions,
    });

    const record: RunRecord = { run: agent.run, meta, dir, log, agent, finished: false };
    this.#records.set(runId, record);

    // Persist before the child does any work, so a run that dies on arrival is still
    // visible in the roster and in cost roll-ups.
    record.meta = { ...meta, status: "running" };
    await writeMeta(dir, record.meta);

    try {
      await agent.start();
    } catch (error) {
      record.finished = true;
      record.meta = { ...record.meta, status: "failed", endedAt: Date.now() };
      await writeMeta(dir, record.meta);
      await log.close();
      this.#onError?.(error, request);
      throw error;
    }

    this.#bus.emit({ type: "run.dispatched", run: agent.run });

    try {
      await agent.prompt(taskPrompt);
    } catch (error) {
      this.#onError?.(error, request);
      await this.#finish(runId);
    }

    return record;
  }

  // -- control --------------------------------------------------------------

  async steer(runId: string, message: string): Promise<void> {
    const record = this.#require(runId);
    await record.log.note(`steer: ${message}`);
    await record.agent.steer(message);
  }

  async abort(runId: string): Promise<void> {
    const record = this.#require(runId);
    await record.log.note("abort requested");
    await record.agent.abort();
  }

  /** Remove a finished run's worktree. Refuses to discard uncommitted work unless forced. */
  async drop(runId: string, options: { force?: boolean; deleteBranch?: boolean } = {}): Promise<RemoveWorktreeResult> {
    const record = this.#require(runId);
    if (!record.finished) {
      throw new Error(`${runId} is still running; abort it first`);
    }
    if (!record.meta.worktree) throw new Error(`${runId} has no worktree to remove`);
    return await removeWorktree(this.#paths.repoRoot, record.meta.worktree, options);
  }

  /** Abort everything still running. Used on shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all(
      this.active.map(async (record) => {
        try {
          await record.agent.stop();
        } catch {
          // Best effort on the way out.
        }
        await record.log.close();
      }),
    );
  }

  dispose(): void {
    this.#unsubscribe();
  }

  #require(runId: string): RunRecord {
    const record = this.#records.get(runId);
    if (!record) throw new Error(`unknown run: ${runId}`);
    return record;
  }

  // -- completion -----------------------------------------------------------

  async #finish(runId: string): Promise<void> {
    const record = this.#records.get(runId);
    if (!record || record.finished) return;
    record.finished = true;

    const run = record.run;
    record.report = this.#reports.get(runId);

    let reportPath: string | undefined;
    if (record.report?.trim()) {
      // `run.lastMessage` is the same text, but only the tail; this is the whole thing.
      reportPath = await writeReport(record.dir, record.report);
    }

    const meta: RunMeta = {
      ...record.meta,
      status: run.status === "failed" ? "failed" : "settled",
      turns: run.turns,
      costUsd: run.costUsd,
      endedAt: run.endedAt ?? Date.now(),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.verdict ? { verdict: run.verdict } : {}),
      ...(reportPath ? { reportPath } : {}),
    };
    record.meta = meta;
    await writeMeta(record.dir, meta);
    await record.log.close();

    const brief: Brief = {
      runId,
      kind: meta.verdict ? "verdict" : meta.status === "failed" ? "blocker" : "report",
      summary: summarize(run, record.report),
      at: Date.now(),
      ...(meta.taskId ? { taskId: meta.taskId } : {}),
    };
    record.brief = brief;
    this.#bus.emit({ type: "run.brief", brief });
    this.#onBrief?.(brief, record);
  }
}

/** Trim a run into something short enough to cross into the supervisor's context. */
export function summarize(run: AgentRun, report: string | undefined, max = 700): string {
  const headline = `${run.role} ${run.taskId ? `#${run.taskId} ` : ""}${run.status} in ${Math.round(
    ((run.endedAt ?? Date.now()) - run.startedAt) / 1000,
  )}s, ${run.turns} turns, $${run.costUsd.toFixed(4)}`;
  const body = (report ?? run.lastMessage ?? "").trim().replace(/\n{3,}/g, "\n\n");
  if (!body) return headline;
  const trimmed = body.length <= max ? body : `${body.slice(0, max - 1)}…`;
  return `${headline}\n\n${trimmed}`;
}
