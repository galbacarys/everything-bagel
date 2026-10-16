/**
 * Landing a change: stage, diff, commit, push, and open a pull request.
 *
 * Kept apart from `worktree.ts` because these are the acts that reach *outside* the local
 * machine, and they should be readable in one place when something has gone wrong.
 *
 * The reviewer sees a staged diff rather than a commit, for two reasons: staging is
 * reversible, and `git diff` on the working tree misses untracked files, so a new file
 * would be invisible to review — which is exactly the kind of change most worth reviewing.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gitRun } from "./worktree.ts";

/** Diffs are capped before they reach a model; the whole patch stays on disk. */
export const MAX_DIFF_BYTES = 60_000;
/** `gh pr create` bodies are written to a file rather than passed inline. */
export const PR_BODY_FILE = "pr-body.md";
export interface Diff {
  patch: string;
  /** True when `patch` was cut short; the full text is at `path`. */
  truncated: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Where the complete patch was written, so nothing is lost by truncating. */
  path?: string;
}

function parseStat(stat: string): { filesChanged: number; additions: number; deletions: number } {
  const files = /(\d+) files? changed/.exec(stat);
  const adds = /(\d+) insertions?\(\+\)/.exec(stat);
  const dels = /(\d+) deletions?\(-\)/.exec(stat);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    additions: adds ? Number(adds[1]) : 0,
    deletions: dels ? Number(dels[1]) : 0,
  };
}

/**
 * Stage everything in a worktree, including untracked files.
 *
 * Staging is what makes a newly created file visible to `git diff`, and it is harmless:
 * `land()` is the only thing that commits, and a failed review leaves the tree as it was.
 */
export async function stageAll(worktree: string): Promise<void> {
  await gitRun(["add", "-A"], worktree);
}

/** The staged change against a base ref, capped, with the full patch saved alongside. */
export async function stagedDiff(
  worktree: string,
  base: string,
  options: { maxBytes?: number; saveTo?: string } = {},
): Promise<Diff> {
  const maxBytes = options.maxBytes ?? MAX_DIFF_BYTES;
  const [stat, patch] = await Promise.all([
    gitRun(["diff", "--cached", "--stat", base], worktree),
    gitRun(["diff", "--cached", base], worktree),
  ]);

  const counts = parseStat(stat);
  const truncated = patch.length > maxBytes;
  if (options.saveTo) {
    await writeFile(options.saveTo, patch, "utf8").catch(() => undefined);
  }

  return {
    patch: truncated ? `${patch.slice(0, maxBytes)}\n\n[diff truncated at ${maxBytes} bytes]` : patch,
    truncated,
    ...counts,
    ...(options.saveTo ? { path: options.saveTo } : {}),
  };
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  /** Set when there was nothing to commit, which is not an error. */
  reason?: string;
}

/** Commit the staged change. Nothing staged is a no-op, not a failure. */
export async function commitStaged(worktree: string, message: string): Promise<CommitResult> {
  const staged = (await gitRun(["diff", "--cached", "--name-only"], worktree)).trim();
  if (!staged) return { committed: false, reason: "nothing staged" };

  await gitRun(["commit", "-m", message], worktree);
  const sha = (await gitRun(["rev-parse", "--short", "HEAD"], worktree)).trim();
  return { committed: true, sha };
}

/**
 * Run `gh`.
 *
 * A separate helper rather than a `git` invocation, because `pr` is not a git
 * subcommand however much it reads like one. Authentication and host selection come from
 * the user's existing `gh` login; bagel never holds a token.
 */
function ghRun(args: string[], cwd: string, timeoutMs = 180_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || `gh ${args.join(" ")} failed: ${error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Push a branch to origin, setting upstream. Requires network and credentials. */
export async function pushBranch(worktree: string, branch: string): Promise<string> {
  return await gitRun(["push", "-u", "origin", branch], worktree, 180_000);
}

export interface PullRequestOptions {
  /** Directory to run `gh` from. The worktree, so it infers the repository. */
  cwd: string;
  title: string;
  body: string;
  /**
   * Where to write the body before passing it. The run directory rather than the
   * worktree: the worktree is about to be pushed, and a stray file in it would be a
   * change nobody asked for.
   */
  bodyPath: string;
  base: string;
  head: string;
}

export interface PullRequest {
  url: string;
  bodyPath: string;
}

/**
 * Open a pull request.
 *
 * The body is written to a file first and passed with `--body-file`, because a plan-sized
 * body on a command line is a quoting problem waiting to happen, and because the body is
 * worth keeping as an artifact of the run.
 */
export async function openPullRequest(options: PullRequestOptions): Promise<PullRequest> {
  // The run directory always exists in practice, but creating it is cheaper than a
  // failure that only shows up when someone points this at a fresh path.
  await mkdir(dirname(options.bodyPath), { recursive: true });
  await writeFile(options.bodyPath, options.body.endsWith("\n") ? options.body : `${options.body}\n`, "utf8");

  const url = await ghRun(
    [
      "pr",
      "create",
      "--title",
      options.title,
      "--body-file",
      options.bodyPath,
      "--base",
      options.base,
      "--head",
      options.head,
    ],
    options.cwd,
  );

  return { url: url.trim(), bodyPath: options.bodyPath };
}

/** How many commits the worktree has that the base ref does not. */
export async function aheadOfBase(worktree: string, base: string): Promise<number> {
  const count = (await gitRun(["rev-list", "--count", `${base}..HEAD`], worktree)).trim();
  return Number.parseInt(count, 10) || 0;
}

/** The repository's pull-request URL for a branch, whether or not one exists yet. */
export async function existingPullRequestUrl(worktree: string, branch: string): Promise<string | undefined> {
  try {
    const url = await ghRun(["pr", "view", branch, "--json", "url", "--jq", ".url"], worktree);
    return url.trim() || undefined;
  } catch {
    return undefined;
  }
}
