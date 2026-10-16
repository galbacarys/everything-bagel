#!/usr/bin/env bun
/**
 * bagel — a control room for agentic software work.
 *
 * This process owns the screen and owns the state. Every agent is a `pi --mode rpc`
 * child whose events become domain events; the supervisor additionally reaches back
 * through a local socket to act on the backlog, the notebook, and gates, because its
 * own tool surface is deliberately limited to those verbs.
 *
 * See docs/design.md for why the seams are where they are.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Container, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { resolveConfig, tierFor } from "./config.ts";
import { Bus } from "./domain/events.ts";
import { ensureRoleFiles } from "./exec/roles.ts";
import { Roster } from "./exec/roster.ts";
import { BridgeServer } from "./ipc/bridge.ts";
import { Notebook } from "./notebook/store.ts";
import { Agent } from "./pi/agent.ts";
import { GateQueue } from "./supervisor/gates.ts";
import { toolPolicyFor } from "./supervisor/policy.ts";
import { supervisorPrompt } from "./supervisor/prompt.ts";
import { buildHandlers } from "./supervisor/verbs.ts";
import { MemoryTracker, type TrackerAdapter } from "./tracker/adapter.ts";
import { Backlog } from "./tracker/backlog.ts";
import { probeGitHub } from "./tracker/github.ts";
import { App } from "./ui/app.ts";
import { ensureProjectDirs, originUrl } from "./util/paths.ts";

const REFRESH_MS = 30_000;
const BACKLOG_LIMIT = 60;

/**
 * Where the bagel extension lives.
 *
 * `--extension` needs a real file for pi's jiti loader, so a compiled binary has to ship
 * this alongside itself. `BAGEL_EXTENSION` is the escape hatch for that case.
 */
function resolveExtensionPath(): string | undefined {
  const explicit = process.env["BAGEL_EXTENSION"]?.trim();
  if (explicit) return explicit;
  try {
    // Relative to this file, so `./` is `src/main.ts` -> `src/extension/bagel.ts`.
    return fileURLToPath(new URL("./extension/bagel.ts", import.meta.url));
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = resolveConfig();
  if ("error" in config) {
    console.error(`bagel: ${config.error}`);
    process.exit(1);
  }

  await ensureProjectDirs(config.paths);

  const bus = new Bus();
  const notebook = new Notebook(config.paths.journal, config.paths.docs);
  const gates = new GateQueue({ bus });

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
  let bridge: BridgeServer | undefined;
  let roster: Roster | undefined;

  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Decline anything outstanding so a parked tool call does not outlive the UI that
    // was going to answer it.
    gates.cancelAll("bagel is shutting down");
    backlog?.stop();
    try {
      await roster?.stopAll();
      roster?.dispose();
    } catch {
      // Best effort.
    }
    try {
      await bridge?.close();
    } catch {
      // Nothing to do on the way out.
    }
    try {
      await supervisor?.stop();
    } catch {
      // Best effort.
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
  app.onGateAnswer = (id, accepted) => {
    if (!gates.resolve(id, { accepted })) return;
    void notebook.append({
      actor: "human",
      kind: "decision",
      body: accepted ? "Approved a gate." : "Declined a gate.",
      tags: ["gate"],
    });
  };

  // -- input ----------------------------------------------------------------

  app.onSubmit = async (text: string): Promise<void> => {
    if (!supervisor) {
      bus.emit({ type: "notice", level: "warn", message: "supervisor is not running" });
      return;
    }
    const entry = await notebook.append({ actor: "human", kind: "session", body: text });
    bus.emit({ type: "notebook.appended", entry });
    try {
      // Steering while busy is why the supervisor runs over RPC rather than as a
      // one-shot process.
      if (supervisor.busy) await supervisor.steer(text);
      else await supervisor.prompt(text);
    } catch (error) {
      bus.emit({ type: "notice", level: "error", message: `supervisor: ${describe(error)}` });
    }
  };

  tui.start();

  // -- coordination plane ---------------------------------------------------

  bus.emit({ type: "notice", level: "info", message: `state ${config.paths.root}` });

  const probe = await probeGitHub(originUrl(config.repoRoot), { cwd: config.repoRoot });
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

  // -- dispatch -------------------------------------------------------------

  const extensionPath = resolveExtensionPath();
  const policy = extensionPath ? toolPolicyFor("supervisor", extensionPath) : undefined;

  // Written once, never overwritten, so an edited role survives an upgrade.
  const roleFiles = await ensureRoleFiles(config.paths.roles);
  if (roleFiles.length) {
    bus.emit({ type: "notice", level: "info", message: `wrote default roles to ${config.paths.roles}` });
  }

  roster = new Roster({
    bus,
    paths: config.paths,
    session: config.session,
    models: config.models,
    ...(extensionPath ? { extensionPath } : {}),
    ...(config.piCli ? { piCli: config.piCli } : {}),
    onError: (error, request) => {
      bus.emit({ type: "notice", level: "error", message: `${request.role}: ${describe(error)}` });
    },
    onBrief: (brief) => {
      void (async () => {
        const kind = brief.kind === "verdict" ? "verdict" : brief.kind === "blocker" ? "blocker" : "work";
        const entry = await notebook.append({
          actor: brief.runId,
          kind,
          body: `${brief.runId} finished: ${firstLine(brief.summary)}`,
          tags: [...(brief.taskId ? [brief.taskId] : []), "brief"],
          ...(brief.taskId ? { taskId: brief.taskId } : {}),
        });
        bus.emit({ type: "notebook.appended", entry });

        // Push it, do not wait to be asked. A brief nobody reads is just a log line.
        const current = supervisor;
        if (!current) return;
        const message = `[bagel] ${brief.runId} finished (${brief.kind}).\n\n${brief.summary}`;
        try {
          // followUp when busy: steering would cut into what it is doing, and a prompt
          // would be rejected outright mid-turn.
          if (current.busy) await current.followUp(message);
          else await current.prompt(message);
        } catch (error) {
          bus.emit({ type: "notice", level: "error", message: `brief delivery failed: ${describe(error)}` });
        }
      })();
    },
  });

  app.onSteer = (runId, message) => {
    void (async () => {
      try {
        await roster?.steer(runId, message);
        const entry = await notebook.append({
          actor: "human",
          kind: "decision",
          body: `Steered ${runId}: ${firstLine(message)}`,
          tags: ["steer"],
        });
        bus.emit({ type: "notebook.appended", entry });
      } catch (error) {
        bus.emit({ type: "notice", level: "error", message: `steer failed: ${describe(error)}` });
      }
    })();
  };

  app.onAbort = (runId) => {
    void (async () => {
      try {
        await roster?.abort(runId);
        bus.emit({ type: "notice", level: "warn", message: `aborting ${runId}` });
      } catch (error) {
        bus.emit({ type: "notice", level: "error", message: `abort failed: ${describe(error)}` });
      }
    })();
  };

  // -- bridge ---------------------------------------------------------------

  bridge = new BridgeServer({
    path: join(config.paths.root, "bridge.sock"),
    handlers: buildHandlers({
      backlog,
      notebook,
      roster,
      gates,
      plansPath: config.paths.plans,
      session: config.session,
      role: "supervisor",
    }),
    onError: (error, verb) => {
      bus.emit({ type: "notice", level: "error", message: `${verb ?? "bridge"}: ${describe(error)}` });
    },
  });

  try {
    await bridge.listen();
  } catch (error) {
    bus.emit({ type: "notice", level: "error", message: `bridge failed to listen: ${describe(error)}` });
    return;
  }

  // -- supervisor -----------------------------------------------------------

  const tier = tierFor("supervisor");
  const model = config.models[tier];

  const appendSystemPrompt = supervisorPrompt({
    repoRoot: config.repoRoot,
    repoId: config.paths.id,
    trackerName: adapter.name,
    notebookPath: config.paths.notebook,
    plansPath: config.paths.plans,
    verbs: bridge.verbs,
    ...(model.model ? { model: model.model } : {}),
  });

  supervisor = new Agent({
    role: "supervisor",
    cwd: config.repoRoot,
    bus,
    sessionName: config.supervisor.sessionName,
    sessionDir: config.supervisor.sessionDir,
    extraArgs: config.supervisor.extraArgs,
    // The bridge is how this session reaches state it does not own. The role decides
    // which verbs the extension registers at all.
    env: {
      BAGEL_BRIDGE: bridge.path,
      BAGEL_ROLE: "supervisor",
      BAGEL_SESSION: config.session,
    },
    ...(policy ? { extension: policy.extension, noBuiltinTools: policy.noBuiltinTools, toolAllowlist: policy.allowlist } : {}),
    ...(model.provider ? { provider: model.provider } : {}),
    ...(model.model ? { model: model.model } : {}),
    ...(model.thinking ? { thinking: model.thinking } : {}),
    appendSystemPrompt,
    ...(config.piCli ? { cliPath: config.piCli } : {}),
  });

  try {
    await supervisor.start();
  } catch (error) {
    bus.emit({ type: "notice", level: "error", message: `cannot start pi: ${describe(error)}` });
    bus.emit({ type: "notice", level: "info", message: "is `pi` on PATH? otherwise set BAGEL_PI_CLI" });
    return;
  }

  // Prime with a small recall block rather than the whole journal. This is what makes a
  // new session cheap to start.
  const recall = await notebook.recall({ recent: 15 });
  const priming = Notebook.formatRecall(recall, Date.now());

  const opening = [
    "Session start.",
    priming ? `\nRecall from your notebook:\n\n${priming}` : "\nYour notebook is empty.",
    `\nBacklog (${adapter.name}):\n${summarizeBacklog(backlog)}`,
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

function firstLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

main().catch((error: unknown) => {
  console.error("bagel: fatal", error);
  process.exit(1);
});
