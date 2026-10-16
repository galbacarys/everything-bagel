#!/usr/bin/env bun
/**
 * Headless dispatch smoke test.
 *
 * Proves the acceptance criterion for dispatch without needing a TTY: a real worker
 * process starts in a real git worktree, does something, reports back, and leaves the
 * main checkout untouched.
 *
 *   bun run scripts/dispatch.ts [task]
 *
 * Writes into the bagel state directory and creates a branch, then removes both. Safe to
 * run repeatedly, but it does spend real tokens.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../src/config.ts";
import { Bus } from "../src/domain/events.ts";
import { Roster } from "../src/exec/roster.ts";
import { ensureRoleFiles } from "../src/exec/roles.ts";
import { Notebook } from "../src/notebook/store.ts";
import { ensureProjectDirs } from "../src/util/paths.ts";

const PROOF_FILE = "WORKER_PROOF.md";
const TIMEOUT_MS = 240_000;

const task =
  process.argv.slice(2).join(" ") ||
  `Create a file named ${PROOF_FILE} at the root of your working directory. It must contain exactly one line: dispatched-by-bagel. Do not modify or create anything else.`;

const config = resolveConfig();
if ("error" in config) {
  console.error(`dispatch: ${config.error}`);
  process.exit(1);
}

await ensureProjectDirs(config.paths);
await ensureRoleFiles(config.paths.roles);

const extensionPath = fileURLToPath(new URL("../src/extension/bagel.ts", import.meta.url));
const bus = new Bus();
const notebook = new Notebook(config.paths.journal, config.paths.docs);

let exportedCost = 0;
bus.on((event) => {
  if (event.type === "run.tool") console.log(`  [tool] ${event.tool}`);
  if (event.type === "run.brief") {
    console.log(`\n[brief] kind=${event.brief.kind}`);
    console.log(event.brief.summary.slice(0, 500));
  }
});
const roster = new Roster({
  bus,
  paths: config.paths,
  session: config.session,
  models: config.models,
  extensionPath,
  ...(config.piCli ? { piCli: config.piCli } : {}),
  onError: (error) => console.error(`[error] ${error instanceof Error ? error.message : String(error)}`),
});

// Wait for the brief, not for `run.settled`. Settling is the child exiting; the brief is
// emitted once the paperwork finishes, which is what this script is actually testing.
const settled = new Promise<string>((resolve) => {
  const off = bus.on((event) => {
    if (event.type === "run.brief") {
      off();
      resolve(event.brief.runId);
    }
  });
});

console.log(`dispatching an implementer into a worktree…\n`);

const record = await roster.start({ role: "implementer", task, slug: "worker-proof", taskId: "7" });
const runId = record.meta.id;
console.log(`run:      ${runId}`);
console.log(`worktree: ${record.meta.worktree}`);
console.log(`branch:   ${record.meta.branch}`);
console.log(`model:    ${record.meta.model ?? "(default)"} thinking=${record.meta.thinking ?? "?"}\n`);

const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS).unref?.());
const outcome = await Promise.race([settled.then((id) => id), timeout]);

const checks: Array<[string, boolean]> = [];
const worktree = record.meta.worktree ?? "";

checks.push(["the run settled rather than timing out", outcome !== "timeout"]);
checks.push(["the worker wrote the file inside its worktree", existsSync(`${worktree}/${PROOF_FILE}`)]);
checks.push(["the main checkout was not touched", !existsSync(`${config.repoRoot}/${PROOF_FILE}`)]);
checks.push(["the worktree is outside the repository", !worktree.startsWith(`${config.repoRoot}/`)]);
checks.push(["the task was written before the worker ran", existsSync(`${record.dir}/task.md`)]);
checks.push(["the raw event stream was recorded", existsSync(`${record.dir}/events.jsonl`)]);
checks.push(["a report was produced", existsSync(`${record.dir}/report.md`)]);
checks.push(["metadata was written", existsSync(`${record.dir}/meta.json`)]);
checks.push(["the brief carries the cost", (record.brief?.summary ?? "").includes("$")]);
checks.push(["the brief exists", record.brief !== undefined]);
checks.push(["the brief names the task", record.brief?.taskId === "7"]);
checks.push(["the task id was recorded", record.meta.taskId === "7"]);
checks.push(["cost was recorded on the run", record.meta.costUsd > 0]);
exportedCost = record.meta.costUsd;

console.log("");
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

// Clean up: the proof file is uncommitted by design, so removing the worktree needs
// force, and the branch goes with it.
if (worktree) {
  const dropped = await roster.drop(runId, { force: true, deleteBranch: true });
  console.log(`\ncleaned up: worktree removed=${dropped.removed} branch=${dropped.branchDeleted ?? "(kept)"}`);
}
roster.dispose();

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\nspend: $${exportedCost.toFixed(4)}`);
console.log(failed === 0 ? "dispatch: PASS" : `dispatch: FAIL (${failed} check(s))`);
process.exit(failed === 0 ? 0 : 1);
