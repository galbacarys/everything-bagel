#!/usr/bin/env bun
/**
 * bagel — a control room for agentic software work.
 *
 * This process owns the screen. Every agent is a `pi --mode rpc` child whose events
 * are translated into domain events (src/pi/agent.ts), which flow through a bus to
 * the UI and, later, to the notebook.
 *
 * The coordination plane is the repository's issue tracker. When it is reachable we
 * use it; when it is not, we say so and fall back to an in-memory backlog so the
 * control room still works.
 */

import { Container, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { resolveConfig } from "./config.ts";
import { Bus } from "./domain/events.ts";
import { Notebook } from "./notebook/store.ts";
import { Agent } from "./pi/agent.ts";
import { supervisorPrompt } from "./supervisor/prompt.ts";
import { MemoryTracker, type TrackerAdapter } from "./tracker/adapter.ts";
import { Backlog } from "./tracker/backlog.ts";
import { probeGitHub } from "./tracker/github.ts";
import { App } from "./ui/app.ts";
import { ensureProjectDirs, originUrl } from "./util/paths.ts";

const REFRESH_MS = 30_000;
const BACKLOG_LIMIT = 60;

async function main(): Promise<void> {
  const config = resolveConfig();
  if ("error" in config) {
    console.error(`bagel: ${config.error}`);
    process.exit(1);
  }

  await ensureProjectDirs(config.paths);

  const bus = new Bus();
  const notebook = new Notebook(config.paths.journal, config.paths.docs);

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  const app = new App({
    bus,
    height: () => terminal.rows,
    requestRender: () => tui.requestRender(),
    repoId: config.paths.id,
    session: config.session,
  });

  const root = new Container();
  root.addChild(app);
  tui.addChild(root);
  tui.setFocus(app);

  // -- shutdown -------------------------------------------------------------

  let shuttingDown = false;
  let supervisor: Agent | undefined;
  let backlog: Backlog | undefined;

  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    backlog?.stop();
    try {
      await supervisor?.stop();
    } catch {
      // Best effort on the way out.
    }
    try {
      tui.stop();
    } catch {
      // The terminal may already be restored.
    }
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  app.onQuit = () => void shutdown(0);

  // -- input ----------------------------------------------------------------

  app.onSubmit = async (text: string): Promise<void> => {
    if (!supervisor) {
      bus.emit({ type: "notice", level: "warn", message: "supervisor is not running" });
      return;
    }
    const entry = await notebook.append({ actor: "human", kind: "session", body: text });
    bus.emit({ type: "notebook.appended", entry });
    try {
      // Steering while busy is the whole reason the supervisor runs over RPC rather
      // than as a one-shot process.
      if (supervisor.busy) await supervisor.steer(text);
      else await supervisor.prompt(text);
    } catch (error) {
      bus.emit({ type: "notice", level: "error", message: `supervisor: ${describe(error)}` });
    }
  };

  tui.start();

  // -- coordination plane ---------------------------------------------------

  bus.emit({ type: "notice", level: "info", message: `state ${config.paths.root}` });

  const remote = originUrl(config.repoRoot);
  const probe = await probeGitHub(remote, { cwd: config.repoRoot });

  let adapter: TrackerAdapter;
  let degradedReason: string | undefined;
  if (probe.ok) {
    adapter = probe.tracker;
  } else {
    adapter = new MemoryTracker();
    degradedReason = probe.reason;
    bus.emit({
      type: "notice",
      level: "warn",
      message: `${probe.reason} — using an in-memory backlog instead`,
    });
  }

  backlog = new Backlog({
    adapter,
    bus,
    refreshMs: REFRESH_MS,
    limit: BACKLOG_LIMIT,
    ...(degradedReason ? { degradedReason } : {}),
  });
  await backlog.start();

  for (const entry of await notebook.tail(30)) {
    bus.emit({ type: "notebook.appended", entry });
  }

  // -- supervisor -----------------------------------------------------------

  const appendSystemPrompt = supervisorPrompt({
    repoRoot: config.repoRoot,
    repoId: config.paths.id,
    trackerName: adapter.name,
    notebookPath: config.paths.notebook,
    plansPath: config.paths.plans,
    ...(config.supervisor.model ? { supervisorModel: config.supervisor.model } : {}),
  });

  supervisor = new Agent({
    role: "supervisor",
    cwd: config.repoRoot,
    bus,
    sessionName: config.supervisor.sessionName,
    sessionDir: config.supervisor.sessionDir,
    trustProjectFiles: config.trustProjectFiles,
    appendSystemPrompt,
    extraArgs: config.supervisor.extraArgs,
    ...(config.piCli ? { cliPath: config.piCli } : {}),
    ...(config.supervisor.provider ? { provider: config.supervisor.provider } : {}),
    ...(config.supervisor.model ? { model: config.supervisor.model } : {}),
  });

  try {
    await supervisor.start();
  } catch (error) {
    bus.emit({ type: "notice", level: "error", message: `cannot start pi: ${describe(error)}` });
    bus.emit({ type: "notice", level: "info", message: "is `pi` on PATH? otherwise set BAGEL_PI_CLI" });
    return; // Leave the UI up so the message is readable.
  }

  // Prime with a small recall block rather than the whole journal. This is what makes
  // a new session cheap to start.
  const recall = await notebook.recall({ recent: 15 });
  const priming = Notebook.formatRecall(recall, Date.now());
  const summary = summarizeBacklog(backlog);

  const opening = [
    "Session start.",
    priming ? `\nRecall from your notebook:\n\n${priming}` : "\nYour notebook is empty.",
    `\nBacklog (${adapter.name}):\n${summary}`,
    "\nGreet me in one line, name the single best next thing to work on, and say why.",
  ].join("\n");

  try {
    await supervisor.prompt(opening);
  } catch (error) {
    bus.emit({ type: "notice", level: "error", message: `supervisor prompt failed: ${describe(error)}` });
  }
}

/** A compact backlog view for the priming message. The full pane is for humans. */
function summarizeBacklog(backlog: Backlog): string {
  const tasks = backlog.tasks;
  if (!tasks.length) return "(no tasks)";
  return tasks
    .slice(0, 20)
    .map((task) => {
      const notes: string[] = [];
      if (task.blockedBy?.length) notes.push(`blocked by ${task.blockedBy.map((b) => `#${b}`).join(",")}`);
      const claim = backlog.claims.find((c) => c.taskId === task.id);
      if (claim) notes.push(`held by ${claim.holder ?? claim.session}`);
      return `- #${task.id} [${task.state}] ${task.title}${notes.length ? ` (${notes.join("; ")})` : ""}`;
    })
    .join("\n");
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

main().catch((error: unknown) => {
  console.error("bagel: fatal", error);
  process.exit(1);
});
