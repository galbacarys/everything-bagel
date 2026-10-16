/**
 * The dispatch layer's pure parts.
 *
 * Roles, branch names, task prompts, and cost roll-up are all deterministic functions of
 * their inputs, so they are tested directly. Actually spawning a child process is verified
 * by `scripts/dispatch.ts`, which is where a real worktree and a real pi process belong.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun } from "../domain/types.ts";
import { buildTaskPrompt, summarize } from "./roster.ts";
import { ensureRoleFiles, loadRole, parseFrontmatter } from "./roles.ts";
import { extractFinalText, listRunMetas, prepareRunDir, rollUp, writeMeta, type RunMeta } from "./runstore.ts";
import { branchFor, parseWorktreeList } from "./worktree.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bagel-exec-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("role frontmatter", () => {
  test("parses keys and body", () => {
    const parsed = parseFrontmatter("---\nthinking: medium\nmodel: openrouter/x\n---\n\nBe careful.\n");
    expect(parsed.fields).toEqual({ thinking: "medium", model: "openrouter/x" });
    expect(parsed.body).toBe("Be careful.");
  });

  test("strips surrounding quotes", () => {
    expect(parseFrontmatter('---\nmodel: "a/b"\n---\nbody').fields["model"]).toBe("a/b");
  });

  test("ignores comment lines and blank values", () => {
    const parsed = parseFrontmatter("---\n# a comment\nthinking:\nmodel: m\n---\nbody");
    expect(parsed.fields).toEqual({ model: "m" });
  });

  test("treats a file with no frontmatter as body only", () => {
    const parsed = parseFrontmatter("just prose");
    expect(parsed.fields).toEqual({});
    expect(parsed.body).toBe("just prose");
  });

  test("an unterminated fence does not swallow the file", () => {
    const parsed = parseFrontmatter("---\nmodel: m\nnever closed");
    expect(parsed.fields).toEqual({});
    expect(parsed.body).toContain("never closed");
  });
});

describe("role loading", () => {
  test("falls back to a built-in default when no file exists", async () => {
    const role = await loadRole(join(dir, "absent"), "implementer");
    expect(role.source).toBe("default");
    expect(role.instructions).toContain("worktree");
  });

  test("a file overrides the default", async () => {
    await writeFile(join(dir, "reviewer.md"), "---\nthinking: xhigh\n---\nBe harsh.\n", "utf8");
    const role = await loadRole(dir, "reviewer");
    expect(role.source).toBe("file");
    expect(role.thinking).toBe("xhigh");
    expect(role.instructions).toBe("Be harsh.");
  });

  test("ensures defaults exactly once and never overwrites edits", async () => {
    const written = await ensureRoleFiles(dir);
    expect(written.length).toBe(3);

    await writeFile(join(dir, "implementer.md"), "---\nthinking: max\n---\nMine.\n", "utf8");
    const again = await ensureRoleFiles(dir);
    expect(again).toEqual([]);
    expect((await loadRole(dir, "implementer")).instructions).toBe("Mine.");
  });
});

// ---------------------------------------------------------------------------

describe("branchFor", () => {
  test("namespaces by session and role", () => {
    expect(branchFor("implementer", "9c1de7b4deadbeef", "Tidy the auth module")).toBe(
      "feat/9c1de7b4-tidy-the-auth-module",
    );
    expect(branchFor("reviewer", "9c1de7b4", "x")).toBe("review/9c1de7b4-x");
  });

  test("survives a slug with nothing usable in it", () => {
    expect(branchFor("implementer", "abcdef12", "!!!")).toBe("feat/abcdef12-task");
  });

  test("never produces a git-illegal name", () => {
    const branch = branchFor("implementer", "abcdef12", "a b/c..d~e^f:g");
    expect(branch).not.toMatch(/[ ~^:?*\[\\]/);
    expect(branch).not.toContain("..");
  });
});

describe("parseWorktreeList", () => {
  test("reads porcelain output", () => {
    const text = [
      "worktree /repo",
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      "worktree /state/worktrees/run-1",
      "HEAD 2222222",
      "branch refs/heads/feat/abc-run-1",
      "",
    ].join("\n");
    expect(parseWorktreeList(text)).toEqual([
      { path: "/repo", head: "1111111", branch: "main" },
      { path: "/state/worktrees/run-1", head: "2222222", branch: "feat/abc-run-1" },
    ]);
  });

  test("a detached worktree has no branch rather than a guessed one", () => {
    const parsed = parseWorktreeList("worktree /x\nHEAD abc\ndetached\n");
    expect(parsed[0]?.branch).toBeUndefined();
  });

  test("handles CRLF and a missing trailing blank line", () => {
    const parsed = parseWorktreeList("worktree /x\r\nHEAD abc\r\nbranch refs/heads/b\r\n");
    expect(parsed).toEqual([{ path: "/x", head: "abc", branch: "b" }]);
  });
});

// ---------------------------------------------------------------------------

describe("buildTaskPrompt", () => {
  const base = { role: "implementer" as const, runId: "implementer-1", worktree: "/state/worktrees/implementer-1" };

  test("states the worktree as the working directory", () => {
    const prompt = buildTaskPrompt({ ...base, task: "Do the thing." });
    expect(prompt).toContain("IS the worktree root");
    expect(prompt).toContain("/state/worktrees/implementer-1");
    expect(prompt).toContain("Do the thing.");
  });

  test("embeds the plan and forbids deviating from it", () => {
    const prompt = buildTaskPrompt({
      ...base,
      planPath: "/state/plans/fix-auth.md",
      planBody: "## Contract\n- touch src/auth.ts",
    });
    expect(prompt).toContain("## The approved plan");
    expect(prompt).toContain("- touch src/auth.ts");
    expect(prompt).toContain("Do not deviate");
    // The authoritative path is named, so the worker never has to reconstruct it.
    expect(prompt).toContain("/state/plans/fix-auth.md");
  });

  test("always carries the working rules and the report format", () => {
    const prompt = buildTaskPrompt({ ...base, task: "x" });
    expect(prompt).toContain("Do not push");
    expect(prompt).toContain("## Report");
  });
});

describe("summarize", () => {
  const run: AgentRun = {
    id: "implementer-1",
    role: "implementer",
    taskId: "41",
    status: "settled",
    turns: 12,
    costUsd: 0.1234,
    startedAt: 1_000,
    endedAt: 61_000,
  };

  test("leads with the numbers that make it skimmable", () => {
    const summary = summarize(run, "Done: changed two files.");
    expect(summary).toContain("implementer #41 settled");
    expect(summary).toContain("60s");
    expect(summary).toContain("12 turns");
    expect(summary).toContain("$0.1234");
    expect(summary).toContain("Done: changed two files.");
  });

  test("truncates a long report so it cannot flood the supervisor", () => {
    const summary = summarize(run, "x".repeat(5000), 700);
    expect(summary.length).toBeLessThan(900);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("still says something when there is no report", () => {
    expect(summarize({ ...run, lastMessage: undefined }, undefined)).toContain("settled");
  });
});

// ---------------------------------------------------------------------------

describe("run store", () => {
  function meta(overrides: Partial<RunMeta>): RunMeta {
    return {
      id: "run-1",
      role: "implementer",
      session: "abc",
      status: "settled",
      turns: 5,
      costUsd: 0.5,
      startedAt: 1_000,
      endedAt: 3_000,
      ...overrides,
    };
  }

  test("round trips metadata", async () => {
    const runPath = await prepareRunDir(dir, "run-1");
    await writeMeta(runPath, meta({ id: "run-1" }));
    const metas = await listRunMetas(dir);
    expect(metas.length).toBe(1);
    expect(metas[0]?.costUsd).toBe(0.5);
  });

  test("skips a run directory with missing or corrupt metadata", async () => {
    await prepareRunDir(dir, "run-good");
    await writeMeta(join(dir, "run-good"), meta({}));
    // No meta.json at all: a run that was killed before it wrote one.
    await prepareRunDir(dir, "run-nometa");
    // Truncated JSON: a crash during the write.
    const corrupt = await prepareRunDir(dir, "run-corrupt");
    await writeFile(join(corrupt, "meta.json"), "{ broken", "utf8");

    const metas = await listRunMetas(dir);
    expect(metas.length).toBe(1);
    expect(metas[0]?.id).toBe("run-1");
  });

  test("missing runs directory is empty, not an error", async () => {
    expect(await listRunMetas(join(dir, "nope"))).toEqual([]);
  });

  test("rolls cost up by role and by model across directories", async () => {
    const a = await prepareRunDir(dir, "a");
    const b = await prepareRunDir(dir, "b");
    await writeMeta(a, meta({ id: "a", role: "implementer", model: "cheap", costUsd: 0.25, turns: 4 }));
    await writeMeta(b, meta({ id: "b", role: "reviewer", model: "careful", costUsd: 0.75, turns: 6, endedAt: 5_000 }));

    const total = await rollUp([dir]);
    expect(total.total.runs).toBe(2);
    expect(total.total.costUsd).toBeCloseTo(1.0, 6);
    expect(total.total.turns).toBe(10);
    expect(total.byRole["implementer"]?.costUsd).toBeCloseTo(0.25, 6);
    expect(total.byRole["reviewer"]?.turns).toBe(6);
    expect(total.byModel["cheap"]?.runs).toBe(1);
    expect(total.firstAt).toBe(1_000);
    expect(total.lastAt).toBe(1_000);
  });

  test("an unfinished run counts, timed to now rather than crashing", async () => {
    const a = await prepareRunDir(dir, "running");
    await writeMeta(a, meta({ id: "running", status: "running", endedAt: undefined, costUsd: 0.1 }));
    const total = await rollUp([dir], 2_000);
    expect(total.total.runs).toBe(1);
    expect(total.total.wallMs).toBe(1_000);
  });
});

describe("extractFinalText", () => {
  test("pulls assistant text out of a message_end", () => {
    const event = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "All done." }] },
    };
    expect(extractFinalText(event)).toBe("All done.");
  });

  test("ignores everything else", () => {
    expect(extractFinalText({ type: "turn_end" })).toBeUndefined();
    expect(extractFinalText({ type: "message_end", message: { role: "user", content: "hi" } })).toBeUndefined();
    expect(extractFinalText(undefined)).toBeUndefined();
  });

  test("an empty assistant message yields nothing rather than an empty report", () => {
    expect(
      extractFinalText({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } }),
    ).toBeUndefined();
  });
});
