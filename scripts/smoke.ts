#!/usr/bin/env bun
/**
 * Headless smoke test for the pi integration.
 *
 * The riskiest part of bagel is not the UI — it is resolving pi's CLI entry point
 * and driving an RPC child correctly. This verifies that end to end without needing
 * a TTY, so it works in CI and over plain pipes.
 *
 *   bun run scripts/smoke.ts [prompt]
 */

import { resolveConfig, tierFor } from "../src/config.ts";
import { Bus } from "../src/domain/events.ts";
import { Agent } from "../src/pi/agent.ts";
import { ensureProjectDirs } from "../src/util/paths.ts";

const prompt = process.argv.slice(2).join(" ") || "Reply with exactly one word: ready";
const TIMEOUT_MS = 120_000;

const config = resolveConfig();
if ("error" in config) {
  console.error(`smoke: ${config.error}`);
  process.exit(1);
}

await ensureProjectDirs(config.paths);

console.log(`repo:  ${config.repoRoot}`);
console.log(`id:    ${config.paths.id}`);
console.log(`state: ${config.paths.root}`);
console.log(`pi:    ${config.piCli ?? "(unresolved)"}`);
console.log(`prompt: ${prompt}`);
console.log("");

const bus = new Bus();
let deltas = 0;
let toolCalls = 0;

bus.on((event) => {
  switch (event.type) {
    case "run.started":
      console.log(`[started] ${event.run.id} role=${event.run.role}`);
      break;
    case "run.delta":
      deltas += 1;
      break;
    case "run.tool":
      toolCalls += 1;
      console.log(`[tool] ${event.tool}`);
      break;
    case "run.settled":
      console.log(
        `[settled] turns=${event.run.turns} cost=$${event.run.costUsd.toFixed(4)} status=${event.run.status}`,
      );
      break;
    case "run.failed":
      console.error(`[failed] ${event.error}`);
      break;
    case "notice":
      console.log(`[${event.level}] ${event.message}`);
      break;
    default:
      break;
  }
});

const model = config.models[tierFor("supervisor")];

const agent = new Agent({
  role: "supervisor",
  cwd: config.repoRoot,
  bus,
  ephemeral: true,
  trustProjectFiles: config.trustProjectFiles,
  appendSystemPrompt: "You are being smoke-tested. Answer in one short line.",
  ...(config.piCli ? { cliPath: config.piCli } : {}),
  ...(model.provider ? { provider: model.provider } : {}),
  ...(model.model ? { model: model.model } : {}),
  ...(model.thinking ? { thinking: model.thinking } : {}),
});

const finished = new Promise<void>((resolve) => {
  const off = bus.on((event) => {
    if (event.type === "run.settled" || event.type === "run.failed") {
      off();
      resolve();
    }
  });
});

let ok = true;
try {
  await agent.start();
  console.log("[started] rpc child is up");
  await agent.prompt(prompt);

  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), TIMEOUT_MS).unref?.();
  });
  const outcome = await Promise.race([finished.then(() => "settled" as const), timeout]);
  if (outcome === "timeout") {
    ok = false;
    console.error(`smoke: timed out after ${TIMEOUT_MS}ms`);
  }
} catch (error) {
  ok = false;
  console.error("smoke: failed", error);
  const stderr = agent.getStderr();
  if (stderr.trim()) console.error(`--- child stderr ---\n${stderr.slice(-2000)}`);
} finally {
  console.log("");
  console.log(`deltas=${deltas} tools=${toolCalls}`);
  console.log("--- last assistant message ---");
  console.log(agent.run.lastMessage ?? "(none)");
  await agent.stop();
}

if (!ok || deltas === 0) {
  console.error("\nsmoke: FAIL");
  process.exit(1);
}
console.log("\nsmoke: PASS");
