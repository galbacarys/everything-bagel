/**
 * Where things live.
 *
 * All bagel state is personal and outside the working tree, keyed by repo identity,
 * so it survives deleting the checkout and never pollutes the tree or your file
 * pickers. See docs/design.md §10.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** Absolute path to the enclosing git worktree, or null when not in a repo. */
export function findRepoRoot(cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** `git rev-parse --git-common-dir` resolves to the main worktree's git dir. */
export function findGitCommonDir(root: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function originUrl(root: string): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Stable identity for a repository. Prefers the origin URL so that two clones of
 * the same project share state; falls back to the absolute path so an unrelated
 * local-only repo still gets its own bucket.
 */
export function repoId(root: string): string {
  const origin = originUrl(root);
  const basis = origin ?? root;
  const slug = basis
    .replace(/\.git$/, "")
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]*@/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(-3)
    .join("-")
    .toLowerCase();
  const hash = createHash("sha256").update(basis).digest("hex").slice(0, 6);
  return `${slug || "repo"}-${hash}`;
}

/** Base directory for all bagel state: `$XDG_STATE_HOME/bagel` or `~/.bagel`. */
export function bagelHome(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  return xdg ? join(xdg, "bagel") : join(homedir(), ".bagel");
}

export interface ProjectPaths {
  repoRoot: string;
  id: string;
  /** `~/.bagel/projects/<id>` */
  root: string;
  projectFile: string;
  plans: string;
  runs: string;
  worktrees: string;
  roles: string;
  notebook: string;
  journal: string;
  docs: string;
  log: string;
}

export function projectPaths(root: string): ProjectPaths {
  const id = repoId(root);
  const base = join(bagelHome(), "projects", id);
  return {
    repoRoot: root,
    id,
    root: base,
    projectFile: join(base, "project.json"),
    plans: join(base, "plans"),
    runs: join(base, "runs"),
    worktrees: join(base, "worktrees"),
    roles: join(base, "roles"),
    notebook: join(base, "notebook"),
    journal: join(base, "notebook", "journal.jsonl"),
    docs: join(base, "notebook", "docs"),
    log: join(base, "bagel.log"),
  };
}

/** Create the state tree, if it is not there yet. Idempotent. */
export async function ensureProjectDirs(paths: ProjectPaths): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await Promise.all(
    [paths.root, paths.plans, paths.runs, paths.worktrees, paths.roles, paths.notebook, paths.docs].map(
      (dir) => mkdir(dir, { recursive: true }),
    ),
  );
}
