#!/usr/bin/env bun
/**
 * Roll-up cost and activity across runs.
 *
 * This is the data layer behind the stats view (#9), and it needs nothing new: every run
 * already writes `meta.json`, so this is a pure aggregation over those files. No database,
 * and it works across every project under the bagel home, because total spend across all
 * repositories is the number that actually matters.
 *
 *   bun run stats            this project
 *   bun run stats --all      every project under the bagel home
 *   bun run stats --json     machine-readable
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { listRunMetas, rollUp, type Bucket } from "../src/exec/runstore.ts";
import { bagelHome, ensureProjectDirs } from "../src/util/paths.ts";

const args = process.argv.slice(2);
const allProjects = args.includes("--all");
const asJson = args.includes("--json");

const config = resolveConfig();
if ("error" in config) {
  console.error(`stats: ${config.error}`);
  process.exit(1);
}
// Bound after the guard, so the narrowing survives into the closure below.
const paths = config.paths;
await ensureProjectDirs(paths);

async function runsDirs(): Promise<string[]> {
  if (!allProjects) return [paths.runs];
  try {
    const projects = await readdir(join(bagelHome(), "projects"));
    return projects.map((project) => join(bagelHome(), "projects", project, "runs"));
  } catch {
    return [];
  }
}

const dirs = await runsDirs();
const total = await rollUp(dirs);

if (asJson) {
  console.log(JSON.stringify(total, null, 2));
  process.exit(0);
}

const money = (value: number): string => `$${value.toFixed(4)}`;
const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
};

function table(title: string, buckets: Record<string, Bucket>): void {
  const rows = Object.entries(buckets).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (!rows.length) return;
  console.log(`\n${title}`);
  console.log(`  ${"".padEnd(22)} ${"runs".padStart(5)} ${"cost".padStart(11)} ${"turns".padStart(7)} ${"time".padStart(8)}`);
  for (const [name, bucket] of rows) {
    console.log(
      `  ${name.slice(0, 22).padEnd(22)} ${String(bucket.runs).padStart(5)} ${money(bucket.costUsd).padStart(11)} ${String(
        bucket.turns,
      ).padStart(7)} ${duration(bucket.wallMs).padStart(8)}`,
    );
  }
}

const scope = allProjects ? "all projects" : paths.id;
console.log(`bagel stats — ${scope}`);
console.log(
  `\ntotal: ${money(total.total.costUsd)}   ${total.total.runs} run(s)   ${total.total.turns} turns   ${duration(
    total.total.wallMs,
  )} of agent time`,
);
if (total.firstAt !== undefined) {
  console.log(`since: ${new Date(total.firstAt).toISOString().slice(0, 16).replace("T", " ")}`);
}
if (total.total.runs === 0) console.log("\n(no runs recorded yet)");

table("by role", total.byRole);
table("by model", total.byModel);

// Per-run detail, newest first, capped so the output stays readable.
const metas = (await Promise.all(dirs.map((dir) => listRunMetas(dir)))).flat();
metas.sort((a, b) => b.startedAt - a.startedAt);
if (metas.length) {
  console.log(`\nrecent runs`);
  for (const meta of metas.slice(0, 15)) {
    const when = new Date(meta.startedAt).toISOString().slice(5, 16).replace("T", " ");
    const outcome = meta.verdict ?? meta.status;
    console.log(
      `  ${when}  ${meta.role.padEnd(12)} ${(meta.taskId ? `#${meta.taskId}` : "—").padEnd(6)} ${outcome.padEnd(9)} ${money(
        meta.costUsd,
      ).padStart(9)}  ${String(meta.turns).padStart(3)}t  ${(meta.model ?? "(default)").slice(0, 28)}`,
    );
  }
  if (metas.length > 15) console.log(`  … and ${metas.length - 15} more`);
}
