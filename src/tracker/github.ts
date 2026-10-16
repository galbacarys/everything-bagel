/**
 * GitHub Issues adapter, driven through the `gh` CLI.
 *
 * Why `gh` rather than REST directly: the CLI already owns authentication, respects
 * `GH_HOST`, and works with whatever the user is logged into. We never touch a token.
 *
 * Two things this file is careful about:
 *
 *  1. **One call per refresh.** The backlog pane re-renders on every keystroke, so
 *     reads are batch operations, never N+1 per issue.
 *  2. **Claims are optimistic.** GitHub has no atomic conditional write, so a claim is
 *     a marker comment followed by a read-back: the earliest surviving marker wins, and
 *     a loser deletes its own marker. See `claim()`.
 */

import { spawn } from "node:child_process";
import type { Claim, Task, TaskId, TaskState } from "../domain/types.ts";
import {
  DEFAULT_CLAIM_TTL_MS,
  isExpired,
  LABEL,
  type ClaimCapable,
  type ClaimOptions,
  type ClaimOutcome,
  type NewTask,
  type TaskFilter,
  type TrackerAdapter,
} from "./adapter.ts";

// ---------------------------------------------------------------------------
// Process helper
// ---------------------------------------------------------------------------

export type GhFailure = "missing" | "unauthenticated" | "unknown-repo" | "timeout" | "failed";

export class GhError extends Error {
  readonly failure: GhFailure;
  readonly args: string[];

  constructor(failure: GhFailure, args: string[], message: string) {
    super(message);
    this.name = "GhError";
    this.failure = failure;
    this.args = args;
  }
}

interface GhOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Written to the child's stdin and closed. Used for long bodies. */
  stdin?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Run `gh` and return its stdout. Rejects with a classified `GhError`. */
function gh(args: string[], options: GhOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        // Never let a missing credential become an interactive prompt that hangs the
        // control room.
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
        CLICOLOR: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new GhError("timeout", args, `gh ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new GhError("missing", args, "gh is not installed or not on PATH"));
        return;
      }
      reject(new GhError("failed", args, error.message));
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new GhError(classify(stderr), args, stderr.trim() || `gh exited ${code}`));    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function classify(stderr: string): GhFailure {
  const text = stderr.toLowerCase();
  if (text.includes("gh auth login") || text.includes("not logged in") || text.includes("authentication")) {
    return "unauthenticated";
  }
  if (text.includes("could not resolve to a repository") || text.includes("http 404")) return "unknown-repo";
  return "failed";
}

/** A one-line reason a probe failed, suitable for a status bar. */
export function describeGhFailure(error: unknown, slug: string): string {
  if (error instanceof GhError) {
    switch (error.failure) {
      case "missing":
        return "gh is not installed or not on PATH";
      case "unauthenticated":
        return "gh is not authenticated (run: gh auth login)";
      case "unknown-repo":
        return `GitHub cannot see ${slug}`;
      case "timeout":
        return "gh timed out";
      default:
        return error.message.split("\n")[0] ?? "gh failed";
    }
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Repo slug
// ---------------------------------------------------------------------------

/**
 * Turn any git remote URL into `owner/name`.
 * Handles https, ssh (`git@host:owner/name.git`), and ssh URL forms.
 */
export function parseRepoSlug(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  if (!trimmed) return undefined;

  const sshMatch = /^[^@/]+@[^:]+:(.+)$/.exec(trimmed);
  if (sshMatch?.[1]) {
    const parts = sshMatch[1].split("/").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
  }

  const urlMatch = /^[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i.exec(trimmed);
  if (urlMatch?.[1]) {
    const parts = urlMatch[1].split("/").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
  }

  const parts = trimmed.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
}

// ---------------------------------------------------------------------------
// Issue mapping
// ---------------------------------------------------------------------------

interface GhLabel {
  name?: unknown;
}

interface GhComment {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  author?: { login?: unknown } | null;
}

interface GhIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  url?: unknown;
  labels?: unknown;
  assignees?: unknown;
  comments?: unknown;
}

const ISSUE_FIELDS = "number,title,body,state,url,labels,assignees,updatedAt";

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function labelNames(value: unknown): string[] {
  return asArray<GhLabel | string>(value)
    .map((label) => (typeof label === "string" ? label : typeof label.name === "string" ? label.name : undefined))
    .filter((name): name is string => Boolean(name));
}

/**
 * Conventions for expressing dependencies in an issue body. Deliberately narrow: a
 * dependency that cannot be read reliably is worse than no dependency at all.
 */
const DEPENDENCY_PATTERN = /(?:blocked\s+by|blocked-by|depends\s+on|requires)\s*:?\s*((?:#\d+[\s,and+]*)+)/gi;

export function parseBlockedBy(body: string): TaskId[] {
  const found = new Set<TaskId>();
  for (const match of body.matchAll(DEPENDENCY_PATTERN)) {
    const group = match[1];
    if (!group) continue;
    for (const ref of group.matchAll(/#(\d+)/g)) {
      if (ref[1]) found.add(ref[1]);
    }
  }
  return [...found];
}

/** Derive bagel's vocabulary from GitHub's open/closed plus bagel's own labels. */
function deriveState(state: unknown, labels: string[]): TaskState {
  if (state === "CLOSED") return "done";
  if (labels.includes(LABEL.inReview)) return "in-review";
  // A claim is a stronger statement about what is happening right now than a
  // dependency that has not landed, so it outranks `blocked`.
  if (labels.includes(LABEL.inProgress)) return "claimed";
  if (labels.includes(LABEL.blocked)) return "blocked";
  return "open";
}

function toTask(issue: GhIssue): Task {
  const body = typeof issue.body === "string" ? issue.body : "";
  const labels = labelNames(issue.labels);
  const blockedBy = parseBlockedBy(body);
  const assignees = asArray<{ login?: unknown }>(issue.assignees)
    .map((a) => (typeof a.login === "string" ? a.login : undefined))
    .filter((login): login is string => Boolean(login));

  return {
    id: String(issue.number ?? ""),
    title: typeof issue.title === "string" ? issue.title : "(untitled)",
    body,
    state: deriveState(issue.state, labels),
    labels,
    ...(typeof issue.url === "string" ? { url: issue.url } : {}),
    ...(assignees[0] ? { assignee: assignees[0] } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
  };
}

// ---------------------------------------------------------------------------
// Claim markers
// ---------------------------------------------------------------------------

const CLAIM_MARKER = /<!--\s*bagel:claim\s*(\{[^>]*?\})\s*-->/;

interface ClaimMarker {
  session?: unknown;
  runId?: unknown;
  at?: unknown;
  ttlMs?: unknown;
  holder?: unknown;
}

/** Parse a claim marker out of a comment body. Exported for tests. */
export function parseClaimMarker(body: string): Claim | undefined {
  const match = CLAIM_MARKER.exec(body);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as ClaimMarker;
    if (typeof parsed.session !== "string") return undefined;
    return {
      taskId: "",
      session: parsed.session,
      ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
      acquiredAt: typeof parsed.at === "number" ? parsed.at : 0,
      ttlMs: typeof parsed.ttlMs === "number" ? parsed.ttlMs : 0,
      ...(typeof parsed.holder === "string" ? { holder: parsed.holder } : {}),
    };
  } catch {
    return undefined;
  }
}

export function renderClaimMarker(claim: Claim): string {
  const payload = JSON.stringify({
    session: claim.session,
    ...(claim.runId ? { runId: claim.runId } : {}),
    at: claim.acquiredAt,
    ttlMs: claim.ttlMs,
    ...(claim.holder ? { holder: claim.holder } : {}),
  });
  return [
    `<!-- bagel:claim ${payload} -->`,
    "",
    `Claimed by bagel session \`${claim.session}\` at ${new Date(claim.acquiredAt).toISOString()}`,
    `Held until ${new Date(claim.acquiredAt + claim.ttlMs).toISOString()}; re-claim to extend.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface GitHubTrackerOptions {
  /** `owner/name`. */
  slug: string;
  /** Directory to run gh from. */
  cwd?: string;
  /** Default claim lifetime. */
  claimTtlMs?: number;
  timeoutMs?: number;
}

/** Label definitions, created on demand so a fresh repository looks intentional. */
const LABEL_META: Array<{ name: string; color: string; description: string }> = [
  { name: LABEL.ready, color: "0e8a16", description: "bagel: ready to be picked up" },
  { name: LABEL.inProgress, color: "fbca04", description: "bagel: claimed by a bagel session" },
  { name: LABEL.inReview, color: "1d76db", description: "bagel: under review" },
  { name: LABEL.blocked, color: "b60205", description: "bagel: blocked on something else" },
  { name: LABEL.laneProd, color: "5319e7", description: "bagel: touches deploy or migrations; serialized" },
];

export class GitHubTracker implements TrackerAdapter, ClaimCapable {
  readonly name: string;
  readonly slug: string;
  readonly #cwd: string | undefined;
  readonly #claimTtlMs: number;
  readonly #timeoutMs: number;
  #labelsEnsured: Promise<void> | undefined;
  #viewer: string | undefined;

  constructor(options: GitHubTrackerOptions) {
    this.slug = options.slug;
    this.name = `GitHub ${options.slug}`;
    this.#cwd = options.cwd;
    this.#claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  #gh(args: string[], stdin?: string): Promise<string> {
    return gh(["--repo", this.slug, ...args], {
      ...(this.#cwd ? { cwd: this.#cwd } : {}),
      timeoutMs: this.#timeoutMs,
      ...(stdin !== undefined ? { stdin } : {}),
    });
  }

  async available(): Promise<boolean> {
    try {
      await gh(["repo", "view", this.slug, "--json", "name,hasIssuesEnabled"], {
        ...(this.#cwd ? { cwd: this.#cwd } : {}),
        timeoutMs: this.#timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Login of the authenticated user, cached. Used to label claim holders. */
  async viewer(): Promise<string | undefined> {
    if (this.#viewer) return this.#viewer;
    try {
      const login = (await gh(["api", "user", "--jq", ".login"], { timeoutMs: this.#timeoutMs })).trim();
      this.#viewer = login || undefined;
      return this.#viewer;
    } catch {
      return undefined;
    }
  }

  /** Create or update the labels bagel relies on. Runs once per process. */
  async ensureLabels(): Promise<void> {
    this.#labelsEnsured ??= (async () => {
      for (const meta of LABEL_META) {
        try {
          await this.#gh([
            "label",
            "create",
            meta.name,
            "--color",
            meta.color,
            "--description",
            meta.description,
            "--force",
          ]);
        } catch {
          // A missing label is not fatal; transitions degrade to partial success.
        }
      }
    })();
    return this.#labelsEnsured;
  }

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    const limit = filter.limit ?? 60;
    const args = [
      "issue",
      "list",
      // `all` so recently-closed work is visible too; callers can filter.
      "--state",
      "all",
      "--limit",
      String(limit),
      "--search",
      "sort:updated-desc",
      "--json",
      ISSUE_FIELDS,
    ];
    // Repeated --label is an AND in gh, which is what a filter should mean.
    for (const label of filter.labels ?? []) args.push("--label", label);

    const raw = await this.#gh(args);
    const partial = (JSON.parse(raw || "[]") as GhIssue[]).map(toTask);

    // Resolve dependencies inside the batch already in hand, so this stays one call.
    // A blocker outside the window counts as unresolved, which fails safe.
    const stateById = new Map(partial.map((task) => [task.id, task.state]));
    const tasks: Task[] = partial.map((task) => {
      // Dependencies only downgrade an *idle* task. They never override a claim or a
      // review in flight, and they never clear an explicit `status:blocked` label.
      if (task.state !== "open") return task;
      const unresolved = (task.blockedBy ?? []).some((id) => stateById.get(id) !== "done");
      return unresolved ? { ...task, state: "blocked" } : task;
    });

    return filter.states?.length ? tasks.filter((t) => filter.states!.includes(t.state)) : tasks;
  }

  async get(id: TaskId): Promise<Task | null> {
    try {
      const raw = await this.#gh(["issue", "view", id, "--json", ISSUE_FIELDS]);
      return toTask(JSON.parse(raw) as GhIssue);
    } catch (error) {
      if (error instanceof GhError && error.failure === "failed" && /not found/i.test(error.message)) return null;
      throw error;
    }
  }

  async create(task: NewTask): Promise<Task> {
    await this.ensureLabels();
    const args = ["issue", "create", "--title", task.title, "--body-file", "-"];
    for (const label of task.labels ?? []) args.push("--label", label);
    const url = (await this.#gh(args, task.body)).trim();

    // gh prints the new issue's URL; the trailing path component is the number.
    const number = url.split("/").pop();
    if (number && /^\d+$/.test(number)) {
      const created = await this.get(number);
      if (created) return created;
    }
    return {
      id: number ?? url,
      title: task.title,
      body: task.body,
      state: "open",
      labels: task.labels ?? [],
      url,
    };
  }

  /** Label changes for a state, as add/remove pairs. */
  #labelDelta(state: TaskState): { add: string[]; remove: string[] } {
    const statusLabels = [LABEL.ready, LABEL.inProgress, LABEL.inReview, LABEL.blocked];
    switch (state) {
      case "claimed":
        return { add: [LABEL.inProgress], remove: [LABEL.ready, LABEL.inReview, LABEL.blocked] };
      case "in-review":
        return { add: [LABEL.inReview], remove: [LABEL.ready, LABEL.inProgress, LABEL.blocked] };
      case "blocked":
        return { add: [LABEL.blocked], remove: [LABEL.ready, LABEL.inProgress, LABEL.inReview] };
      case "done":
        return { add: [], remove: statusLabels };
      case "open":
      default:
        return { add: [LABEL.ready], remove: [LABEL.inProgress, LABEL.inReview, LABEL.blocked] };
    }
  }

  async transition(id: TaskId, state: TaskState): Promise<Task> {
    await this.ensureLabels();
    const { add, remove } = this.#labelDelta(state);
    const args = ["issue", "edit", id];
    for (const label of add) args.push("--add-label", label);
    for (const label of remove) args.push("--remove-label", label);
    await this.#gh(args);

    await this.#gh(state === "done" ? ["issue", "close", id] : ["issue", "reopen", id]);

    const updated = await this.get(id);
    if (!updated) throw new Error(`issue #${id} disappeared after transition`);
    return updated;
  }

  async comment(id: TaskId, body: string): Promise<void> {
    await this.#gh(["issue", "comment", id, "--body-file", "-"], body);
  }

  // -- claims ---------------------------------------------------------------

  /**
   * Take a claim on a task.
   *
   * GitHub cannot do a conditional write, so this is optimistic: post a marker, then
   * re-read. The earliest surviving marker wins, and a loser removes its own marker so
   * the record stays clean.
   */
  async claim(id: TaskId, session: string, options: ClaimOptions = {}): Promise<ClaimOutcome> {
    const holder = await this.viewer();
    const mine: Claim = {
      taskId: id,
      session,
      acquiredAt: Date.now(),
      ttlMs: options.ttlMs ?? this.#claimTtlMs,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(holder ? { holder } : {}),
    };

    await this.comment(id, renderClaimMarker(mine));

    // Ranking the comment's server-side timestamp first, then session id, makes the
    // winner deterministic even when two markers share a second.
    const live = (await this.claimsFor(id)).filter((claim) => !isExpired(claim));
    live.sort((a, b) => a.acquiredAt - b.acquiredAt || a.session.localeCompare(b.session));
    const winner = live[0];

    if (!winner || winner.session === session) {
      await this.transition(id, "claimed").catch(() => undefined);
      return { ok: true, claim: mine };
    }

    await this.#deleteOwnClaimComment(id, session).catch(() => undefined);
    return { ok: false, claim: mine, holder: winner };
  }

  /** Extend a claim by re-stamping its marker. */
  async heartbeat(id: TaskId, session: string, ttlMs?: number): Promise<boolean> {
    const mine = (await this.claimsFor(id)).find((claim) => claim.session === session);
    if (!mine) return false;
    await this.comment(id, renderClaimMarker({ ...mine, acquiredAt: Date.now(), ttlMs: ttlMs ?? mine.ttlMs }));
    return true;
  }

  /** Remove a session's claim markers from a task, returning it to ready if unclaimed. */
  async release(id: TaskId, session: string): Promise<void> {
    await this.#deleteOwnClaimComment(id, session);
    const remaining = (await this.claimsFor(id)).filter((claim) => !isExpired(claim));
    if (!remaining.length) await this.transition(id, "open").catch(() => undefined);
  }

  /** Every live claim, in one call. Only claimed issues are fetched, so this is cheap. */
  async claims(): Promise<Claim[]> {
    const raw = await this.#gh([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      LABEL.inProgress,
      "--limit",
      "100",
      "--json",
      "number,comments",
    ]);
    const issues = JSON.parse(raw || "[]") as GhIssue[];
    const now = Date.now();
    const out: Claim[] = [];
    for (const issue of issues) {
      const id = String(issue.number ?? "");
      for (const claim of this.#parseComments(id, issue.comments)) {
        if (!isExpired(claim, now)) out.push(claim);
      }
    }
    return out;
  }

  /** Every claim marker on one task, expired or not, oldest first. */
  async claimsFor(id: TaskId): Promise<Claim[]> {
    const raw = await this.#gh(["issue", "view", id, "--json", "comments"]);
    const parsed = JSON.parse(raw || "{}") as GhIssue;
    return this.#parseComments(id, parsed.comments).sort((a, b) => a.acquiredAt - b.acquiredAt);
  }

  #parseComments(id: TaskId, comments: unknown): Claim[] {
    const out: Claim[] = [];
    for (const comment of asArray<GhComment>(comments)) {
      const body = typeof comment.body === "string" ? comment.body : "";
      const claim = parseClaimMarker(body);
      if (!claim) continue;
      const ref = typeof comment.id === "string" ? comment.id : undefined;
      const author = comment.author && typeof comment.author.login === "string" ? comment.author.login : undefined;
      const createdAt = typeof comment.createdAt === "string" ? Date.parse(comment.createdAt) : Number.NaN;
      out.push({
        ...claim,
        taskId: id,
        // Prefer the comment's server-side timestamp over the client's, which may be
        // skewed or simply wrong.
        acquiredAt: Number.isFinite(createdAt) ? createdAt : claim.acquiredAt,
        ...(ref ? { ref } : {}),
        ...(author && !claim.holder ? { holder: author } : {}),
      });
    }
    return out;
  }

  async #deleteOwnClaimComment(id: TaskId, session: string): Promise<void> {
    for (const claim of await this.claimsFor(id)) {
      if (claim.session !== session || !claim.ref) continue;
      // Deleting a comment we authored is permitted, and keeps the thread clean.
      await gh(["api", "-X", "DELETE", `repos/${this.slug}/issues/comments/${claim.ref}`], {
        timeoutMs: this.#timeoutMs,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

export type GitHubProbe =
  | { ok: true; tracker: GitHubTracker }
  | { ok: false; reason: string };

/**
 * Build an adapter for a repository, or explain why not. The reason is reported in the
 * header, because "the backlog is empty" and "the tracker is not reachable" look
 * identical otherwise.
 */
export async function probeGitHub(
  remoteUrl: string | null | undefined,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<GitHubProbe> {
  if (!remoteUrl) return { ok: false, reason: "no git remote named origin" };
  const slug = parseRepoSlug(remoteUrl);
  if (!slug) return { ok: false, reason: `cannot parse a repository from ${remoteUrl}` };

  const tracker = new GitHubTracker({
    slug,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });

  try {
    await gh(["repo", "view", slug, "--json", "name,hasIssuesEnabled"], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      timeoutMs: options.timeoutMs ?? 15_000,
    });
    return { ok: true, tracker };
  } catch (error) {
    return { ok: false, reason: describeGhFailure(error, slug) };
  }
}
