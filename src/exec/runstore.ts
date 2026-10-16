/**
 * Run directories: what a worker leaves behind.
 *
 * Every run gets `<state>/runs/<run-id>/` holding the exact task it was given, the raw
 * event stream, the final report, and a machine-readable `meta.json`. The point of the
 * last one is that cost analysis becomes a pure aggregation: nothing else has to be
 * persisted, and no database has to exist for "what has this cost me" to have an answer.
 */

import { appendFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role, RunStatus } from "../domain/types.ts";

export interface RunMeta {
  id: string;
  role: Role;
  taskId?: string;
  /** The bagel session that dispatched this run. */
  session: string;
  model?: string;
  thinking?: string;
  worktree?: string;
  branch?: string;
  base?: string;
  status: RunStatus;
  exitCode?: number | null;
  turns: number;
  costUsd: number;
  startedAt: number;
  endedAt?: number;
  verdict?: "PASS" | "BLOCK";
  /** Where the full report landed, when there is one. */
  reportPath?: string;
  /** Set on a reviewer: the run whose work it reviewed. */
  reviewsRun?: string;
  /** Set once the change has been pushed and a pull request opened. */
  prUrl?: string;
}

export function runDir(runsDir: string, runId: string): string {
  return join(runsDir, runId);
}

export async function prepareRunDir(runsDir: string, runId: string): Promise<string> {
  const dir = runDir(runsDir, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The exact prompt handed to the child, kept so a run can be explained later. */
export async function writeTask(dir: string, task: string): Promise<string> {
  const path = join(dir, "task.md");
  await writeFile(path, task.endsWith("\n") ? task : `${task}\n`, "utf8");
  return path;
}

export async function writeReport(dir: string, report: string): Promise<string> {
  const path = join(dir, "report.md");
  await writeFile(path, report.endsWith("\n") ? report : `${report}\n`, "utf8");
  return path;
}

export async function writeMeta(dir: string, meta: RunMeta): Promise<void> {
  // Written to a temporary name and renamed, so a crash mid-write cannot leave a
  // half-parsed meta.json that the aggregator then trips over.
  const target = join(dir, "meta.json");
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temporary, target);
}

export async function readMeta(dir: string): Promise<RunMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as RunMeta;
  } catch {
    return undefined;
  }
}

/** Every readable run under a runs directory. Corrupt or in-flight runs are skipped. */
export async function listRunMetas(runsDir: string): Promise<RunMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }
  const metas = await Promise.all(entries.map((entry) => readMeta(join(runsDir, entry))));
  return metas.filter((meta): meta is RunMeta => meta !== undefined);
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * Append-only writer for a run's raw event stream.
 *
 * Kept open across the run because a busy worker emits thousands of events, and opening
 * a file per event would be slower than the work it is recording.
 */
export class RunLog {
  #handle: Awaited<ReturnType<typeof open>> | undefined;
  readonly path: string;
  #pending: string[] = [];
  #closing = false;

  constructor(dir: string) {
    this.path = join(dir, "events.jsonl");
  }

  async open(): Promise<void> {
    this.#handle = await open(this.path, "a");
  }

  write(event: unknown): void {
    if (!this.#handle) return;
    this.#pending.push(`${JSON.stringify(event)}\n`);
    // Batch: a flush per event would make the transcript the slowest part of the run.
    if (this.#pending.length >= 64) void this.flush();
  }

  async flush(): Promise<void> {
    const handle = this.#handle;
    if (!handle || this.#pending.length === 0) return;
    const batch = this.#pending.join("");
    this.#pending = [];
    await handle.write(batch).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await this.flush();
    await this.#handle?.close().catch(() => undefined);
    this.#handle = undefined;
  }

  /** Append one line, for the few things worth recording that are not protocol events. */
  async note(note: string): Promise<void> {
    await appendFile(this.path, `${JSON.stringify({ type: "bagel.note", note, at: Date.now() })}\n`, "utf8").catch(
      () => undefined,
    );
  }
}

/**
 * Pull the final assistant text out of a recorded event stream.
 *
 * The stream is the authoritative record, so the report is derived from it rather than
 * accumulated from deltas that might have been missed.
 */
export function extractFinalText(event: unknown): string | undefined {
  const record = event as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
  if (!record || record.type !== "message_end") return undefined;
  if (record.message?.role !== "assistant") return undefined;
  const content = record.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      const value = (part as { text?: unknown })?.text;
      return typeof value === "string" ? value : "";
    })
    .join("");
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

export interface Bucket {
  runs: number;
  costUsd: number;
  turns: number;
  wallMs: number;
}

export interface RollUp {
  total: Bucket;
  byRole: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
  /** Oldest and newest run timestamps seen, for "since when". */
  firstAt?: number;
  lastAt?: number;
}

function emptyBucket(): Bucket {
  return { runs: 0, costUsd: 0, turns: 0, wallMs: 0 };
}

function addTo(bucket: Bucket, meta: RunMeta, now: number): void {
  bucket.runs += 1;
  bucket.costUsd += meta.costUsd || 0;
  bucket.turns += meta.turns || 0;
  bucket.wallMs += Math.max(0, (meta.endedAt ?? now) - meta.startedAt);
}

/**
 * Aggregate runs across any number of run directories.
 *
 * Takes a list of directories rather than one, so the same function answers both "this
 * project" and "every project under the bagel home".
 */
export async function rollUp(runsDirs: string[], now: number = Date.now()): Promise<RollUp> {
  const result: RollUp = { total: emptyBucket(), byRole: {}, byModel: {} };

  for (const dir of runsDirs) {
    for (const meta of await listRunMetas(dir)) {
      addTo(result.total, meta, now);
      const role = (result.byRole[meta.role] ??= emptyBucket());
      addTo(role, meta, now);
      const model = (result.byModel[meta.model ?? "(default)"] ??= emptyBucket());
      addTo(model, meta, now);
      if (result.firstAt === undefined || meta.startedAt < result.firstAt) result.firstAt = meta.startedAt;
      if (result.lastAt === undefined || meta.startedAt > result.lastAt) result.lastAt = meta.startedAt;
    }
  }

  return result;
}
