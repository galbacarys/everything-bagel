/**
 * Configuration resolution. One repository per bagel instance; all personal state
 * lives under the bagel home, keyed by repo identity.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supervisorPrompt } from "./supervisor/prompt.ts";
import { findRepoRoot, projectPaths, type ProjectPaths } from "./util/paths.ts";

export interface SupervisorConfig {
  provider?: string;
  model?: string;
  /** Appended to pi's system prompt. */
  appendSystemPrompt: string;
  sessionName: string;
  sessionDir: string;
  extraArgs: string[];
}

export interface Config {
  repoRoot: string;
  paths: ProjectPaths;
  /** Identity of this bagel instance. Recorded on claims and journal entries. */
  session: string;
  /** Absolute path to pi's JS entry point. */
  piCli?: string;
  /** Whether to trust project-local extensions and skills. */
  trustProjectFiles: boolean;
  supervisor: SupervisorConfig;
}

export type ConfigResult = Config | { error: string };

/**
 * Walk up looking for the installed pi package. Deterministic, and independent of
 * however the module resolver chooses to represent a package that has a `bin`.
 */
function findPiPackageDir(fromUrl: string): string | undefined {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(fromUrl));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve a package's declared bin to an absolute path, but only if it is a JS
 * file. `RpcClient` runs `node <cliPath>`, so a POSIX shell launcher would fail here;
 * refusing anything that is not JavaScript is the point of this function.
 */
function resolveBin(packageDir: string, name: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      bin?: Record<string, string> | string;
    };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name];
    if (!bin) return undefined;
    if (!/\.(js|mjs|cjs)$/.test(bin)) return undefined;
    const candidate = join(packageDir, bin);
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the JavaScript entry point for pi.
 *
 * `RpcClient` spawns `node <cliPath>`, so this must be a JS file. `pi` on PATH is a
 * POSIX shell launcher, which `node` cannot run — hence resolving the entry from our
 * own pinned dependency, which also makes bagel's pi version reproducible.
 */
export function resolvePiCli(fromUrl: string = import.meta.url): string | undefined {
  const explicit = process.env["BAGEL_PI_CLI"]?.trim();
  if (explicit) return explicit;

  const local = findPiPackageDir(fromUrl);
  if (local) {
    const resolved = resolveBin(local, "pi");
    if (resolved) return resolved;
  }

  try {
    const require = createRequire(fromUrl);
    let dir = dirname(require.resolve("@earendil-works/pi-coding-agent"));
    for (let depth = 0; depth < 6; depth++) {
      if (existsSync(join(dir, "package.json"))) {
        const resolved = resolveBin(dir, "pi");
        if (resolved) return resolved;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Resolution is best-effort; the caller reports a missing CLI.
  }
  return undefined;
}

/** Fallback discovery for the case where our dependency is missing. */
function resolvePiFromPath(): string | undefined {
  try {
    const which = execFileSync("which", ["pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return which || undefined;
  } catch {
    return undefined;
  }
}

export function resolveConfig(cwd: string = process.cwd()): ConfigResult {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    return { error: `${cwd} is not inside a git repository` };
  }

  const paths = projectPaths(repoRoot);
  const provider = process.env["BAGEL_SUPERVISOR_PROVIDER"]?.trim() || undefined;
  const model = process.env["BAGEL_SUPERVISOR_MODEL"]?.trim() || undefined;

  const piCli = resolvePiCli() ?? resolvePiFromPath();

  const appendSystemPrompt = supervisorPrompt({
    repoRoot,
    repoId: paths.id,
    trackerName: "GitHub Issues (adapter pending; running in-memory)",
    notebookPath: paths.notebook,
    plansPath: paths.plans,
    ...(model ? { supervisorModel: model } : {}),
  });

  return {
    repoRoot,
    paths,
    session: randomUUID().slice(0, 8),
    ...(piCli ? { piCli } : {}),
    trustProjectFiles: false,
    supervisor: {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      appendSystemPrompt,
      sessionName: `bagel:${paths.id}`,
      sessionDir: join(paths.root, "sessions"),
      extraArgs: [],
    },
  };
}
