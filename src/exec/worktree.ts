/**
 * Git worktrees: one isolated checkout per run.
 *
 * Worktrees live under the bagel state directory, outside the repository, so agent work
 * never shows up in the main checkout's status, in file pickers, or in search results.
 *
 * The danger here is not creating worktrees, it is removing them. `git worktree remove`
 * on a dirty tree discards a worker's unfinished work permanently, so removal checks
 * first and refuses unless the caller says it really means it.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "../domain/types.ts";

const GIT_TIMEOUT_MS = 60_000;

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(args: string[], stderr: string) {
    super(stderr.trim() || `git ${args.join(" ")} failed`);
    this.name = "GitError";
    this.args = args;
    this.stderr = stderr;
  }
}

/** Run git and return stdout. Rejects with a `GitError` carrying stderr. */
export function gitRun(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(args, stderr || String(error)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await gitRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which ref a worktree should branch from.
 *
 * `origin/HEAD` is the honest answer when it exists, because it is the remote's notion
 * of the default branch. Falling back to `main` then `master` keeps a fresh clone with
 * no remote usable.
 */
export async function defaultBase(repoRoot: string): Promise<string> {
  try {
    const ref = (await gitRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot)).trim();
    if (ref && (await refExists(repoRoot, ref))) return ref;
  } catch {
    // No origin, or no remote HEAD set. Fall through.
  }
  for (const candidate of ["main", "master"]) {
    if (await refExists(repoRoot, candidate)) return candidate;
  }
  return "HEAD";
}

/** `feat/9c1de7b4-fix-token-refresh` */
export function branchFor(role: Role, session: string, slug: string): string {
  const prefix =
    role === "implementer" ? "feat" : role === "reviewer" ? "review" : role === "scout" ? "scout" : "chore";
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const short = session.slice(0, 8);
  return `${prefix}/${short}-${clean || "task"}`;
}

export interface Worktree {
  runId: string;
  path: string;
  branch: string;
  base: string;
  createdAt: number;
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  /** Parent directory for all bagel worktrees, i.e. `<state>/worktrees`. */
  baseDir: string;
  runId: string;
  branch: string;
  /** Ref to branch from. Defaults to the repository's default branch. */
  base?: string;
}

/**
 * Create an isolated checkout for one run.
 *
 * The base ref is resolved and recorded rather than assumed, because "branched from
 * main" is only meaningful if you know which commit it actually pointed at.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  const base = options.base ?? (await defaultBase(options.repoRoot));
  const path = join(options.baseDir, options.runId);

  await mkdir(options.baseDir, { recursive: true });
  // A leftover directory from a crashed run would make `worktree add` fail.
  if (existsSync(path)) await rm(path, { recursive: true, force: true });

  await gitRun(["worktree", "add", "-b", options.branch, path, base], options.repoRoot);

  return { runId: options.runId, path, branch: options.branch, base, createdAt: Date.now() };
}

/** Parse `git worktree list --porcelain` into a list. */
export function parseWorktreeList(text: string): Array<{ path: string; head: string; branch?: string }> {
  const out: Array<{ path: string; head: string; branch?: string }> = [];
  let current: { path?: string; head?: string; branch?: string } = {};

  const flush = (): void => {
    if (current.path) {
      out.push({
        path: current.path,
        head: current.head ?? "",
        ...(current.branch ? { branch: current.branch } : {}),
      });
    }
    current = {};
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    // `branch` is absent for a detached worktree, which is exactly when we do not want
    // to guess a branch name.
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
  }
  flush();
  return out;
}

export async function listWorktrees(repoRoot: string): Promise<Array<{ path: string; head: string; branch?: string }>> {
  return parseWorktreeList(await gitRun(["worktree", "list", "--porcelain"], repoRoot));
}

export interface WorktreeState {
  path: string;
  branch?: string;
  head: string;
  /** Uncommitted or untracked files. Non-empty means removal would lose work. */
  changes: string[];
  committedAhead: number;
}

/** What a worktree currently holds, so a human can decide whether it is safe to drop. */
export async function worktreeState(repoRoot: string, path: string): Promise<WorktreeState> {
  const [status, head, branches] = await Promise.all([
    gitRun(["status", "--porcelain"], path),
    gitRun(["rev-parse", "--short", "HEAD"], path),
    gitRun(["rev-parse", "--abbrev-ref", "HEAD"], path),
  ]);

  const changes = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  // Commits the worker made but that are not on the base branch are also work worth
  // knowing about before removing the worktree.
  let committedAhead = 0;
  try {
    const base = await defaultBase(repoRoot);
    const count = (await gitRun(["rev-list", "--count", `${base}..HEAD`], path)).trim();
    committedAhead = Number.parseInt(count, 10) || 0;
  } catch {
    committedAhead = 0;
  }

  const branch = branches.trim();
  return {
    path,
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    head: head.trim(),
    changes,
    committedAhead,
  };
}

export interface RemoveWorktreeOptions {
  /** Remove even when the tree is dirty, discarding uncommitted work. */
  force?: boolean;
  /** Also delete the branch. Off by default: an unmerged branch is work worth keeping. */
  deleteBranch?: boolean;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** Set when removal was refused because work would have been lost. */
  reason?: string;
  state: WorktreeState;
  branchDeleted?: string;
}

/**
 * Remove a worktree.
 *
 * Refuses on a dirty tree unless `force` is set, because the alternative is silently
 * destroying a worker's unfinished work. The branch is kept unless explicitly asked for,
 * since an unmerged branch is recoverable and a deleted one is not.
 */
export async function removeWorktree(
  repoRoot: string,
  path: string,
  options: RemoveWorktreeOptions = {},
): Promise<RemoveWorktreeResult> {
  const state = await worktreeState(repoRoot, path);

  if (!options.force && (state.changes.length > 0 || state.committedAhead > 0)) {
    const parts: string[] = [];
    if (state.changes.length) parts.push(`${state.changes.length} uncommitted file(s)`);
    if (state.committedAhead) parts.push(`${state.committedAhead} commit(s) not on the base branch`);
    return {
      removed: false,
      reason: `refusing to remove a worktree with ${parts.join(" and ")}; pass force to discard`,
      state,
    };
  }

  await gitRun(["worktree", "remove", ...(options.force ? ["--force"] : []), path], repoRoot);
  await gitRun(["worktree", "prune"], repoRoot).catch(() => "");

  let branchDeleted: string | undefined;
  if (options.deleteBranch && state.branch) {
    await gitRun(["branch", "-D", state.branch], repoRoot);
    branchDeleted = state.branch;
  }

  return { removed: true, state, ...(branchDeleted ? { branchDeleted } : {}) };
}

/** Drop worktree registrations whose directories are already gone. */
export async function pruneWorktrees(repoRoot: string): Promise<string> {
  return await gitRun(["worktree", "prune"], repoRoot);
}
