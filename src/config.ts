/**
 * Configuration resolution.
 *
 * One repository per bagel instance; all personal state lives under the bagel home,
 * keyed by repo identity. Configuration comes from two files and the environment, in
 * that order of increasing precedence.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Role } from "./domain/types.ts";
import { bagelHome, findRepoRoot, projectPaths, type ProjectPaths } from "./util/paths.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

/**
 * Exactly two model tiers, deliberately: one that plans, one that executes. More tiers
 * than that is a tuning problem wearing a feature's clothes.
 */
export type ModelTier = "supervisor" | "implementer";

export interface SupervisorConfig {
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
  /** Editor for viewing and editing artifacts. */
  editor?: string;
  models: Record<ModelTier, ModelChoice>;
  supervisor: SupervisorConfig;
}

export type ConfigResult = Config | { error: string };

/** Shape of `~/.bagel/config.json` and the per-project `project.json`. */
export interface ConfigFile {
  editor?: string;
  models?: Partial<Record<ModelTier, ModelChoice>>;
}

/** Which tier a role draws its model from. */
export function tierFor(role: Role): ModelTier {
  return role === "supervisor" ? "supervisor" : "implementer";
}

// ---------------------------------------------------------------------------
// pi CLI discovery
// ---------------------------------------------------------------------------

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
 * Resolve a package's declared bin to an absolute path, but only if it is a JS file.
 * `RpcClient` runs `node <cliPath>`, so a POSIX shell launcher would fail here; refusing
 * anything that is not JavaScript is the point of this function.
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
 * `pi` on PATH is a POSIX shell launcher, which `node` cannot run, so the entry is
 * resolved from our own pinned dependency — which also makes bagel's pi version
 * reproducible.
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
    // Best effort; the caller reports a missing CLI.
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

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A missing or malformed config file is not worth failing startup over; defaults
    // are always valid.
    return undefined;
  }
}

/** Global then per-project, with the project file winning. */
export function loadConfigFile(projectFile: string): ConfigFile {
  const global = readJsonFile<ConfigFile>(join(bagelHome(), "config.json")) ?? {};
  const project = readJsonFile<ConfigFile>(projectFile) ?? {};
  return {
    ...global,
    ...project,
    models: { ...global.models, ...project.models },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Which editor to open artifacts in.
 *
 * `$BAGEL_EDITOR` wins so a single invocation can override; then the config file, which
 * is the deliberate choice; then the conventional variables, because a user who has set
 * `$EDITOR` has already answered this question.
 */
function resolveEditor(file: ConfigFile): string | undefined {
  return (
    process.env["BAGEL_EDITOR"]?.trim() ||
    file.editor?.trim() ||
    process.env["VISUAL"]?.trim() ||
    process.env["EDITOR"]?.trim() ||
    undefined
  );
}

const DEFAULT_THINKING: Record<ModelTier, ThinkingLevel> = {
  supervisor: "high",
  implementer: "low",
};

/** Model config from a config file plus environment overrides. */
function resolveModels(file: ConfigFile): Record<ModelTier, ModelChoice> {
  const pick = (tier: ModelTier): ModelChoice => {
    const configured = file.models?.[tier] ?? {};
    const envProvider = process.env[`BAGEL_${tier.toUpperCase()}_PROVIDER`]?.trim();
    const envModel = process.env[`BAGEL_${tier.toUpperCase()}_MODEL`]?.trim();
    const envThinking = process.env[`BAGEL_${tier.toUpperCase()}_THINKING`]?.trim() as ThinkingLevel | undefined;
    return {
      ...(envProvider ? { provider: envProvider } : configured.provider ? { provider: configured.provider } : {}),
      ...(envModel ? { model: envModel } : configured.model ? { model: configured.model } : {}),
      thinking: envThinking || configured.thinking || DEFAULT_THINKING[tier],
    };
  };
  return { supervisor: pick("supervisor"), implementer: pick("implementer") };
}

export function resolveConfig(cwd: string = process.cwd()): ConfigResult {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    return { error: `${cwd} is not inside a git repository` };
  }

  const paths = projectPaths(repoRoot);
  const file = loadConfigFile(paths.projectFile);
  const piCli = resolvePiCli() ?? resolvePiFromPath();
  const editor = resolveEditor(file);

  return {
    repoRoot,
    paths,
    session: randomUUID().slice(0, 8),
    ...(piCli ? { piCli } : {}),
    trustProjectFiles: false,
    ...(editor ? { editor } : {}),
    models: resolveModels(file),
    supervisor: {
      sessionName: `bagel:${paths.id}`,
      sessionDir: join(paths.root, "sessions"),
      extraArgs: [],
    },
  };
}
