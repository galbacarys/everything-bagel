#!/usr/bin/env bun
/**
 * bagel — a control room for agentic software work.
 *
 * This process owns the screen. Every agent is a `pi --mode rpc` child whose events
 * are translated into domain events (src/pi/agent.ts), which flow through a bus to
 * the UI and later to the notebook.
 */

import { Container, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { resolveConfig } from "./config.ts";
import { Bus } from "./domain/events.ts";
import { Notebook } from "./notebook/store.ts";
import { Agent } from "./pi/agent.ts";
import { MemoryTracker } from "./tracker/adapter.ts";
import { App } from "./ui/app.ts";
import { ensureProjectDirs } from "./util/paths.ts";

async function main(): Promise<void> {
  const config = resolveConfig();
  if ("error" in config) {
    console.error(`bagel: ${config.error}`);
    process.exit(1);
  }

  await ensureProjectDirs(config.paths);

  const bus = new Bus();
  const tracker = new MemoryTracker();
  const notebook = new Notebook(config.paths.journal, config.paths.docs);

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  const app = new App({
    bus,
    height: () => terminal.rows,
    requestRender: () => tui.requestRender(),
    repoId: config.paths.id,
    session: config.session,
    trackerName: tracker.name,
  });

  const root = new Container();
  root.addChild(app);
  tui.addChild(root);
  tui.setFocus(app);

  // -- shutdown -------------------------------------------------------------

  let shuttingDown = false;
  let supervisor: Agent | undefined;

  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await supervisor?.stop();
    } catch {
      // Best effort on the way out.
    }
    try {
      tui.stop();
    } catch {
      // Terminal may already be restored.
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
      // Steering while busy is the whole reason the supervisor runs over RPC
      // rather than as a one-shot process.
      if (supervisor.busy) await supervisor.steer(text);
      else await supervisor.prompt(text);
    } catch (error) {
      bus.emit({ type: "notice", level: "error", message: `supervisor: ${String(error)}` });
    }
  };

  tui.start();

  // -- initial state --------------------------------------------------------

  bus.emit({ type: "notice", level: "info", message: `state ${config.paths.root}` });

  const tasks = await tracker.list();
  bus.emit({ type: "backlog.updated", tasks });  for (const entry of await notebook.tail(30)) {
    bus.emit({ type: "notebook.appended", entry });
  }

  // -- supervisor -----------------------------------------------------------

  supervisor = new Agent({
    role: "supervisor",
    cwd: config.repoRoot,
    bus,
    sessionName: config.supervisor.sessionName,
    sessionDir: config.supervisor.sessionDir,
    trustProjectFiles: config.trustProjectFiles,
    appendSystemPrompt: config.supervisor.appendSystemPrompt,
    extraArgs: config.supervisor.extraArgs,
    ...(config.piCli ? { cliPath: config.piCli } : {}),
    ...(config.supervisor.provider ? { provider: config.supervisor.provider } : {}),
    ...(config.supervisor.model ? { model: config.supervisor.model } : {}),
  });

  try {
    await supervisor.start();
  } catch (error) {
    bus.emit({ type: "notice", level: "error", message: `cannot start pi: ${String(error)}` });
    bus.emit({ type: "notice", level: "info", message: "is `pi` on PATH? otherwise set BAGEL_PI_CLI" });
    return; // Leave the UI up so the message is readable.
  }

  // Prime with a small recall block rather than the whole journal. This is what
  // makes a new session cheap to start.
  const recall = await notebook.recall({ recent: 15 });
  const priming = Notebook.formatRecall(recall, Date.now());
  const opening = priming
    ? `Session start. Recall from your notebook:\n\n${priming}\n\nGreet me in one line and tell me what is ready in the backlog.`
    : `Session start. The notebook is empty and there is no backlog yet. Greet me in one line and say so.`;

  try {
    await supervisor.prompt(opening);
  } catch (error) {
    bus.emit({ type: "notice", level: "error", message: `supervisor prompt failed: ${String(error)}` });
  }
}

main().catch((error: unknown) => {
  console.error("bagel: fatal", error);
  process.exit(1);
});
