#!/usr/bin/env bun
/**
 * End-to-end loop verification: task -> plan -> approval -> dispatch -> review -> land.
 *
 * This drives the *real* verb handlers, the real roster, the real plan store, and the real
 * git operations. The only thing it stands in for is the language model: instead of a
 * supervisor deciding what to do, this script calls the verbs in the order a supervisor
 * would, and answers the gate the way a human would.
 *
 *   bun run loop
 *
 * It creates a real branch and opens a real pull request. That is the point — the last
 * stage of the loop cannot be verified without one. It prints the URL so the pull request
 * can be reviewed or closed.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveConfig, tierFor } from "../src/config.ts";
import { Bus, type DomainEvent } from "../src/domain/events.ts";
import { Plans } from "../src/exec/plans.ts";
import { ensureRoleFiles } from "../src/exec/roles.ts";
import { Roster } from "../src/exec/roster.ts";
import { BridgeServer } from "../src/ipc/bridge.ts";
import { Notebook } from "../src/notebook/store.ts";
import { GateQueue } from "../src/supervisor/gates.ts";
import { buildHandlers } from "../src/supervisor/verbs.ts";
import { MemoryTracker } from "../src/tracker/adapter.ts";
import { Backlog } from "../src/tracker/backlog.ts";
import { ensureProjectDirs } from "../src/util/paths.ts";

const SLUG = "document-the-loop";
/** A second, deliberately never-approved plan, so the refusal check stays honest on
 *  re-runs. Reusing the real slug would pass only once, since it is approved by then. */
const UNAPPROVED_SLUG = "refusal-probe";
const TASK_ID = "3";
const STEP_TIMEOUT_MS = 420_000;

const PLAN = `## Contract

Add a file \`docs/loop.md\` describing bagel's end-to-end path, in roughly 40 lines.

## What it must contain

One \`#\` heading, a two-sentence introduction, then one \`##\` section per stage, in this
order:

1. task — the supervisor proposes, a human picks, the task is claimed
2. plan — written to disk and approved by a human; the approval is what grants permission
3. dispatch — a worker in its own git worktree, branched from the default branch
4. review — an independent reviewer reads the plan and the staged diff
5. land — commit, push, open a pull request for a human to read

## Constraints

- Plain Markdown. No invented flags, no invented paths.
- Mention only \`bagel\`, \`bun run\`, and the stage names above.
- Do not create or modify any file other than \`docs/loop.md\`.

## Acceptance

- \`docs/loop.md\` exists.
- All five stages appear, in order.
- No other file is changed.`;

// ---------------------------------------------------------------------------

const config = resolveConfig();
if ("error" in config) {
  console.error(`loop: ${config.error}`);
  process.exit(1);
}
await ensureProjectDirs(config.paths);
await ensureRoleFiles(config.paths.roles);

const bus = new Bus();
const notebook = new Notebook(config.paths.journal, config.paths.docs);
const plans = new Plans(config.paths.plans);
const gates = new GateQueue({ bus });
const backlog = new Backlog({ adapter: new MemoryTracker(), bus });
const extensionPath = fileURLToPath(new URL("../src/extension/bagel.ts", import.meta.url));

const roster = new Roster({
  bus,
  paths: config.paths,
  plans,
  session: config.session,
  models: config.models,
  extensionPath,
  ...(config.piCli ? { piCli: config.piCli } : {}),
  onError: (error) => console.error(`  [error] ${error instanceof Error ? error.message : String(error)}`),
});

// Workers reach bagel through the bridge, so it has to be up for their notebook tools to
// work. Same socket path the app uses.
const handlers = buildHandlers({
  backlog,
  notebook,
  roster,
  plans,
  gates,
  session: config.session,
  role: "supervisor",
});
const bridge = new BridgeServer({ path: join(config.paths.root, "bridge.sock"), handlers });
await bridge.listen();

/** Call a verb the way the extension does, minus the socket framing. */
async function call(verb: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const handler = handlers[verb];
  if (!handler) throw new Error(`no handler for ${verb}`);
  return await handler(args, { verb, signal: new AbortController().signal });
}

/** Resolve when a brief lands for this run, or throw on timeout. */
function waitForBrief(runId: string): Promise<DomainEvent & { type: "run.brief" }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${STEP_TIMEOUT_MS}ms waiting for ${runId}`));
    }, STEP_TIMEOUT_MS);
    const off = bus.on((event) => {
      if (event.type !== "run.brief" || event.brief.runId !== runId) return;
      clearTimeout(timer);
      off();
      resolve(event);
    });
  });
}

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean): void => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const step = (label: string): void => console.log(`\n=== ${label} ===`);

/** Show tool activity for a run, so the loop is legible while it happens. */
bus.on((event) => {
  if (event.type === "run.tool") {
    const record = roster.get(event.runId);
    if (record && record.meta.role !== "supervisor") console.log(`  [${record.meta.role}] ${event.tool}`);
  }
});

// ---------------------------------------------------------------------------
// 1. Plan
// ---------------------------------------------------------------------------

step("plan");
const written = (await call("plan.write", { slug: SLUG, taskId: TASK_ID, body: PLAN })) as {
  slug: string;
  path: string;
};
console.log(`wrote ${written.slug} -> ${written.path}`);
check("the plan file exists", existsSync(written.path));

// The invariant that matters most: dispatch must refuse a plan nobody approved.
step("an unapproved plan must be refused");
await plans.write(UNAPPROVED_SLUG, TASK_ID, "A plan that is never approved.");
let refused = false;
let refusal = "";
try {
  await call("dispatch.start", { role: "implementer", planSlug: UNAPPROVED_SLUG, slug: UNAPPROVED_SLUG });
} catch (error) {
  refused = true;
  refusal = error instanceof Error ? error.message : String(error);
}
check("dispatch refuses an unapproved plan", refused);
check("nothing was created for the refused dispatch", !existsSync(join(config.paths.worktrees, UNAPPROVED_SLUG)));
console.log(`  refused with: ${refusal}`);

// ---------------------------------------------------------------------------
// 2. Approve, the way a human answering the gate would
// ---------------------------------------------------------------------------

step("approval");
const pending = call("gate.request", {
  kind: "plan",
  prompt: `Approve the plan "${SLUG}"?`,
  accept: "approve plan",
  ref: SLUG,
});

// Let the gate register, then answer it as the UI would.
await new Promise((resolve) => setTimeout(resolve, 50));
const open = gates.current;
check("the gate is waiting for a human", open !== undefined && open.ref === SLUG);
gates.resolve(open!.id, { accepted: true });

const decision = (await pending) as { accepted: boolean; granted?: string; note?: string };
check("the gate reports approval", decision.accepted === true);
check("approval recorded a grant against the plan", decision.granted === SLUG);

const approved = await plans.get(SLUG);
check("the plan is approved on disk", approved?.approvedAt !== undefined);

// ---------------------------------------------------------------------------
// 3. Dispatch
// ---------------------------------------------------------------------------

step("dispatch");
const implementer = (await call("dispatch.start", {
  role: "implementer",
  planSlug: SLUG,
  taskId: TASK_ID,
  slug: SLUG,
})) as { runId: string; worktree?: string; branch?: string };
console.log(`  ${implementer.runId} on ${implementer.branch}`);
const implBrief = await waitForBrief(implementer.runId);
console.log(`\n--- implementer brief ---\n${implBrief.brief.summary.slice(0, 600)}\n`);

const implRecord = roster.get(implementer.runId);
check("the implementer ran in a worktree", Boolean(implRecord?.meta.worktree));
check(
  "the worktree is outside the repository",
  !(implRecord?.meta.worktree ?? "").startsWith(`${config.repoRoot}/`),
);
check("the main checkout is untouched", !existsSync(join(config.repoRoot, "docs/loop.md")));

// ---------------------------------------------------------------------------
// 4. Review
// ---------------------------------------------------------------------------

step("review");
const reviewer = (await call("dispatch.review", {
  runId: implementer.runId,
  planSlug: SLUG,
})) as { runId: string; round: number };
console.log(`  ${reviewer.runId} (round ${reviewer.round})`);
const revBrief = await waitForBrief(reviewer.runId);
console.log(`\n--- reviewer brief ---\n${revBrief.brief.summary.slice(0, 900)}\n`);

const verdict = roster.get(reviewer.runId)?.meta.verdict;
check("the reviewer returned a verdict", verdict !== undefined);

// ---------------------------------------------------------------------------
// 5. Land
// ---------------------------------------------------------------------------

step("land");
if (verdict !== "PASS") {
  check("land would refuse without a PASS", true);
  console.log(`  reviewer said ${verdict ?? "(nothing)"}; not landing. Read the report above.`);
} else {
  const landed = (await call("dispatch.land", {
    runId: implementer.runId,
    title: `Document the end-to-end loop (closes #${TASK_ID})`,
    body: [
      "Adds `docs/loop.md`, describing the path from a chosen task to an opened pull request.",
      "",
      `Closes #${TASK_ID}`,
      "",
      `Plan: \`${written.path}\``,
      `Implementer: \`${implementer.runId}\``,
      `Reviewed by: \`${reviewer.runId}\` (VERDICT: PASS)`,
    ].join("\n"),
  })) as { url: string; branch: string; base: string };
  console.log(`  ${landed.url}`);
  console.log(`  ${landed.branch} -> ${landed.base}`);
  check("a pull request was opened", landed.url.startsWith("http"));
  console.log(`\nReview it, then merge or close: ${landed.url}`);
}

// Drop worktrees whose work is safely on the remote, so repeated runs do not accumulate
// checkouts. Anything without a pull request is left exactly where it is: that work is
// not on the remote, and removing it would destroy it.
for (const record of roster.records) {
  if (!record.meta.prUrl || !record.meta.worktree) continue;
  await roster.drop(record.meta.id, { force: true }).catch(() => undefined);
}

await bridge.close();
roster.dispose();

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
console.log(failed === 0 ? "loop: PASS" : `loop: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
