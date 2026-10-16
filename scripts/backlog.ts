#!/usr/bin/env bun
/**
 * Inspect the repository's tracker from the terminal, without the UI.
 *
 * Read-only by default, so it is safe to run anywhere. `--seed` is the exception and
 * will create issues — it asks for nothing and prints what it did.
 *
 *   bun run scripts/backlog.ts              # list tasks and derived state
 *   bun run scripts/backlog.ts --json       # machine-readable
 *   bun run scripts/backlog.ts --claims     # live claims only
 *   bun run scripts/backlog.ts --seed       # create the starter backlog (writes!)
 */

import { resolveConfig } from "../src/config.ts";
import type { NewTask, TrackerAdapter } from "../src/tracker/adapter.ts";
import { GitHubTracker, probeGitHub } from "../src/tracker/github.ts";
import { originUrl } from "../src/util/paths.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const claimsOnly = args.includes("--claims");
const seed = args.includes("--seed");
/** Inspect any repository, not just this one. Read-only: seeding is refused. */
const slugArg = args.find((a) => a.startsWith("--slug="))?.slice("--slug=".length);

const config = resolveConfig();
if ("error" in config) {
  console.error(`backlog: ${config.error}`);
  process.exit(1);
}

let tracker: GitHubTracker;
if (slugArg) {
  tracker = new GitHubTracker({ slug: slugArg });
  if (!(await tracker.available())) {
    console.error(`backlog: GitHub cannot see ${slugArg} (or gh is not authenticated)`);
    process.exit(1);
  }
} else {
  const probe = await probeGitHub(originUrl(config.repoRoot), { cwd: config.repoRoot });
  if (!probe.ok) {
    console.error(`backlog: ${probe.reason}`);
    process.exit(1);
  }
  tracker = probe.tracker;
}

if (seed) {
  if (slugArg) {
    console.error("backlog: refusing to seed a repository passed via --slug");
    process.exit(1);
  }
  await seedBacklog(tracker);
}

const tasks = await tracker.list({ limit: 60 });
const claims = await tracker.claims();

if (asJson) {
  console.log(JSON.stringify({ slug: tracker.slug, tasks, claims }, null, 2));
} else if (claimsOnly) {
  if (!claims.length) {
    console.log(`${tracker.name}: no live claims`);
  } else {
    for (const claim of claims) {
      const age = Math.round((Date.now() - claim.acquiredAt) / 60_000);
      console.log(
        `#${claim.taskId}  ${claim.holder ?? "?"}  session=${claim.session}  held ${age}m of ${Math.round(claim.ttlMs / 60_000)}m`,
      );
    }
  }
} else {
  console.log(`${tracker.name}  —  ${tasks.length} tasks, ${claims.length} live claims\n`);
  if (!tasks.length) {
    console.log("(no tasks; try --seed)");
  }
  for (const task of tasks) {
    const notes: string[] = [];
    if (task.blockedBy?.length) notes.push(`blocked by ${task.blockedBy.map((b) => `#${b}`).join(",")}`);
    const claim = claims.find((c) => c.taskId === task.id);
    if (claim) notes.push(`held by ${claim.holder ?? claim.session}`);
    const suffix = notes.length ? `  (${notes.join("; ")})` : "";
    console.log(`#${task.id.padEnd(4)} [${task.state.padEnd(9)}] ${task.title}${suffix}`);
    if (task.labels.length) console.log(`      ${task.labels.join("  ")}`);
  }
}

/**
 * Create a starter backlog. Deliberately includes a dependency so that
 * `parseBlockedBy` and the derived `blocked` state get exercised on real data.
 */
async function seedBacklog(tracker: TrackerAdapter): Promise<void> {
  const existing = await tracker.list({ limit: 1 });
  if (existing.length > 0) {
    console.log(`tracker already has ${existing.length}+ tasks; not seeding`);
    return;
  }

  const plan: Array<NewTask & { dependsOn?: number }> = [
    {
      title: "Give the supervisor typed lifecycle verbs",
      body: [
        "The supervisor currently holds pi's default tools, so the design's central claim —",
        "that the action space *is* the lifecycle — is not actually enforced. Replace the",
        "defaults with typed verbs.",
        "",
        "Scope:",
        "- A pi extension registering `backlog.*`, `plan.write`, `dispatch.*`, `notebook.*`,",
        "  `gate.request`.",
        "- A unix-socket bridge so the extension forwards calls to the bagel process, which",
        "  stays authoritative for state, authority checks, and side effects.",
        "- Extension dialogs routed through the extension UI subprotocol so approval prompts",
        "  are drawn by bagel.",
        "",
        "Done when the supervisor can list the backlog and append a journal entry through",
        "tools, and an approval prompt appears as a bagel dialog.",
      ].join("\n"),
      labels: ["status:ready", "type:feat"],
    },
    {
      title: "Dispatch workers into worktrees and watch them live",
      body: [
        "Turn the agents pane from a stub into the real thing.",
        "",
        "Scope:",
        "- Create, list, and prune git worktrees under the state directory.",
        "- One `pi --mode rpc` child per run, reporting status, cost, turns, and last tool.",
        "- Bind `steer` and `abort` to keys in the agents pane.",
        "- Route a short `Brief` back to the supervisor; keep the long report on disk.",
        "- Role definitions at `<state>/roles/*.md` with frontmatter.",
        "",
        "Done when approving a plan produces a worker editing its own worktree while you",
        "watch, and you can steer it mid-run.",
      ].join("\n"),
      labels: ["status:ready", "type:feat"],
    },
    {
      title: "Close the loop: plan approval, independent review, pull request",
      body: [
        "The full path from request to pull request.",
        "",
        "Scope:",
        "- Write the plan artifact and request approval; approval issues the task-scoped grant.",
        "- Launch an independent reviewer as a separate process with a separate context.",
        "- Read the verdict from the review artifact, never from stdout.",
        "- Cap the review loop at three rounds, then escalate to the human.",
        "- Auto-write notebook entries from run lifecycle events.",
      ].join("\n"),
      labels: ["status:ready", "type:feat"],
    },
    {
      title: "Rank review work into a hit list instead of a raw diff",
      body: [
        "A raw diff is a haystack; nobody says which three hunks matter. Rank hunks by",
        "criticality with one batched classifier call and open `$EDITOR` on the result.",
        "",
        "Scope:",
        "- Score each hunk with a single `classify()` call using ordered `score` criteria.",
        "- Render a ranked hit list with file:line anchors and a reason per hit.",
        "- Hand off to `$EDITOR` as a jump target, not an integration surface.",
        "",
        "Classifier calls bill on input tokens only, so the cost is roughly a tenth of a",
        "cent per pull request. See docs/platform-notes.md.",
      ].join("\n"),
      labels: ["status:ready", "type:feat"],
    },
    {
      title: "Gate risky commands with a cheap classifier",
      body: [
        "Per-command risk gating, prefiltered so it stays free in both money and latency.",
        "",
        "Scope:",
        "- A heuristic prefilter that separates obviously-safe from ambiguous commands.",
        "- Classify only the ambiguous tail, with the verdict cached by command shape.",
        "- Default to asking on anything destructive or irreversible.",
        "",
        "Measured cost is a fraction of a cent per session; the real budget is latency, so",
        "the prefilter matters more than the model choice.",
      ].join("\n"),
      labels: ["status:ready", "type:feat"],
      // Depends on the dispatch work, so the derived `blocked` state has real input.
      dependsOn: 1,
    },
  ];

  const created: number[] = [];
  for (const task of plan) {
    const prerequisite = task.dependsOn === undefined ? undefined : created[task.dependsOn];
    const body =
      prerequisite === undefined ? task.body : `${task.body}\n\nDepends on #${prerequisite}.`;
    const { dependsOn: _ignored, ...rest } = task;
    const issue = await tracker.create({ ...rest, body });
    created.push(Number(issue.id));
    console.log(`created #${issue.id}  ${task.title}`);
  }

  console.log("\nseeded. run without --seed to see the derived state.");
}
