#!/usr/bin/env bun
/**
 * Render the control room to stdout at a fixed size, without a TTY.
 *
 * Lets us iterate on layout over plain pipes, and gives the UI a snapshot test that
 * does not need terminal emulation. Feed it synthetic state to see every pane at
 * once.
 *
 *   bun run scripts/render-preview.ts [width] [height] [--live]
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { Bus } from "../src/domain/events.ts";
import type { AgentRun, JournalEntry, Task } from "../src/domain/types.ts";
import { App } from "../src/ui/app.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const width = Number.parseInt(args[0] ?? "150", 10);
const height = Number.parseInt(args[1] ?? "42", 10);

const bus = new Bus();
const app = new App({
  bus,
  height: () => height,
  requestRender: () => {},
  repoId: "acme-widgets-4f2a19",
  session: "9c1de7b4",
  trackerName: "GitHub Issues",
});

const now = Date.now();

const tasks: Task[] = [
  { id: "41", title: "token refresh fails on expiry", state: "open", labels: ["status:ready", "type:fix"] },
  { id: "42", title: "billing proration off by a cent", state: "open", labels: ["status:ready"] },
  {
    id: "43",
    title: "add /healthz endpoint",
    state: "blocked",
    labels: ["type:feat"],
    blockedBy: ["41"],
  },
  { id: "39", title: "extract retry helper", state: "in-review", labels: [] },
  { id: "38", title: "drop unused legacy shim", state: "done", labels: [] },
];

const runs: AgentRun[] = [
  {
    id: "implementer-1",
    role: "implementer",
    taskId: "41",
    status: "running",
    turns: 7,
    costUsd: 0.04,
    startedAt: now - 134_000,
    lastTool: "edit src/auth/refresh.ts",
  },
  {
    id: "reviewer-1",
    role: "reviewer",
    taskId: "39",
    status: "settled",
    turns: 3,
    costUsd: 0.01,
    startedAt: now - 260_000,
    endedAt: now - 198_000,
    verdict: "PASS",
  },
  {
    id: "supervisor-1",
    role: "supervisor",
    status: "running",
    turns: 2,
    costUsd: 0.02,
    startedAt: now - 300_000,
  },
];

const journal: JournalEntry[] = [
  { id: "a1", at: now - 2_400_000, actor: "supervisor", kind: "session", body: "session started, primed from notebook", tags: [] },
  { id: "a2", at: now - 2_100_000, actor: "supervisor", kind: "work", body: "#41 claimed by implementer-1", tags: ["41"] },
  { id: "a3", at: now - 1_800_000, actor: "supervisor", kind: "decision", body: "split #41 from #42: same module, but #42 depends on the new cache shape", tags: ["41", "42"] },
  { id: "a4", at: now - 900_000, actor: "implementer-1", kind: "discovery", body: "refresh token is cached in module scope; that is why expiry reads stale", tags: ["41"] },
  { id: "a5", at: now - 400_000, actor: "reviewer-1", kind: "verdict", body: "PASS on #39 — retry helper matches the existing backoff policy", tags: ["39"] },
  { id: "a6", at: now - 120_000, actor: "supervisor", kind: "blocker", body: "waiting on approval before touching the migration", tags: ["41"] },
];

const supervisorText = `# Backlog

Two items are ready. **#41** is the recommended start.

## Why #41 first

- It is small, and #42 touches the same module
- #43 is blocked by it, so starting it unblocks two things

| id | size | note |
|----|------|------|
| #41 | S | recommended |
| #42 | M | same module as #41 |

Shall I write the plan for #41?

> Gate: plan approval will be requested before anything is claimed.`;

bus.emit({ type: "backlog.updated", tasks });
for (const run of runs) bus.emit({ type: "run.started", run });
for (const entry of journal) bus.emit({ type: "notebook.appended", entry });
bus.emit({ type: "notice", level: "info", message: "~/.bagel/projects/acme-widgets-4f2a19" });
bus.emit({ type: "run.delta", runId: "supervisor-1", text: supervisorText });

if (process.argv.includes("--live")) {
  let frame = 0;
  setInterval(() => {
    frame += 1;
    const target = runs[0];
    if (target) {
      target.turns = 7 + frame;
      target.costUsd = 0.04 + frame * 0.004;
      bus.emit({ type: "run.updated", run: target });
    }
    const lines = app.render(width);
    process.stdout.write(`\x1b[H\x1b[2J${lines.join("\n")}\n`);
  }, 500);
} else {
  const lines = app.render(width);
  process.stdout.write(`${lines.join("\n")}\n`);
  // Measure with the same width accounting the renderer uses: ANSI escapes, cursor
  // markers, wide characters, and combining marks all change visible width.
  const widest = Math.max(...lines.map((line) => visibleWidth(line)));
  const overflow = lines.filter((line) => visibleWidth(line) > width).length;
  process.stderr.write(
    `\nrendered ${lines.length} rows, widest visible line ${widest} cols (viewport ${width} x ${height})\n`,
  );
  if (overflow > 0) {
    process.stderr.write(`WARNING: ${overflow} row(s) exceed the viewport width\n`);
    process.exitCode = 1;
  }
}
