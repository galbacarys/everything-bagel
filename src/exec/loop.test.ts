/**
 * Plans, grants, and the git operations that land a change.
 *
 * The git tests run against a real throwaway repository rather than a mock, because the
 * properties worth protecting are git's own behaviour: that a staged diff includes files
 * that did not exist before, and that committing nothing is a no-op rather than a failure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitStaged, openPullRequest, stageAll, stagedDiff } from "./gitops.ts";
import { Plans, PlanNotApprovedError } from "./plans.ts";
import { buildReviewTask } from "./roster.ts";
import { gitRun } from "./worktree.ts";
import { parseFrontmatter, renderFrontmatter, toSlug } from "../util/frontmatter.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bagel-loop-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("frontmatter", () => {
  test("round trips through render and parse", () => {
    const text = renderFrontmatter({ slug: "a-b", task: "41", approved: "2026-01-01T00:00:00.000Z" }, "Body here.");
    const parsed = parseFrontmatter(text);
    expect(parsed.fields["slug"]).toBe("a-b");
    expect(parsed.fields["approved"]).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.body).toBe("Body here.");
  });

  test("omits undefined values rather than writing empty keys", () => {
    const text = renderFrontmatter({ slug: "x", approved: undefined }, "b");
    expect(text).not.toContain("approved");
  });

  test("toSlug cannot escape a directory or produce an illegal git ref", () => {
    expect(toSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(toSlug("Fix: the AUTH module!")).toBe("fix-the-auth-module");
    expect(toSlug("a b..c~d^e:f")).not.toContain("..");
    expect(toSlug("")).toBe("task");
    expect(toSlug("!!!", "")).toBe("");
  });
});

describe("plans", () => {
  test("a written plan starts unapproved and can be read back", async () => {
    const plans = new Plans(join(dir, "plans"));
    const written = await plans.write("fix-auth", "41", "## Contract\n- touch auth.ts");
    expect(written.approvedAt).toBeUndefined();

    const read = await plans.get("fix-auth");
    expect(read?.taskId).toBe("41");
    expect(read?.body).toContain("touch auth.ts");
    expect(read?.approvedAt).toBeUndefined();
  });

  test("approval is recorded on disk, which is the grant", async () => {
    const plans = new Plans(join(dir, "plans"));
    await plans.write("fix-auth", "41", "body");
    const at = 1_700_000_000_000;
    const approved = await plans.approve("fix-auth", at);
    expect(approved.approvedAt).toBe(at);

    // A fresh instance reads it from the file, so the grant is not in-memory state.
    expect((await new Plans(join(dir, "plans")).get("fix-auth"))?.approvedAt).toBe(at);
  });

  test("approving twice keeps the first timestamp", async () => {
    const plans = new Plans(join(dir, "plans"));
    await plans.write("x", undefined, "b");
    await plans.approve("x", 1000);
    await plans.approve("x", 2000);
    expect((await plans.get("x"))?.approvedAt).toBe(1000);
  });

  test("rewriting a plan does not silently revoke its approval", async () => {
    const plans = new Plans(join(dir, "plans"));
    await plans.write("x", "1", "first");
    await plans.approve("x", 5000);
    const rewritten = await plans.write("x", "1", "second");
    expect(rewritten.approvedAt).toBe(5000);
    expect((await plans.get("x"))?.body).toBe("second");
  });

  test("requireApproved refuses an unapproved plan and names it", async () => {
    const plans = new Plans(join(dir, "plans"));
    await plans.write("pending", "7", "b");
    expect(plans.requireApproved("pending")).rejects.toBeInstanceOf(PlanNotApprovedError);
    await plans.approve("pending");
    expect((await plans.requireApproved("pending")).slug).toBe("pending");
  });

  test("requireApproved refuses a plan that does not exist", async () => {
    const plans = new Plans(join(dir, "plans"));
    expect(plans.requireApproved("nope")).rejects.toThrow(/no plan at/);
  });

  test("approving a plan that does not exist throws", async () => {
    const plans = new Plans(join(dir, "plans"));
    expect(plans.approve("ghost")).rejects.toThrow(/no plan at/);
  });

  test("a slug is sanitised into a filename that cannot escape the directory", async () => {
    const plans = new Plans(join(dir, "plans"));
    const written = await plans.write("../../escape", "1", "b");
    expect(written.path.startsWith(join(dir, "plans"))).toBe(true);
    expect(written.path).not.toContain("..");
  });

  test("list returns every plan with its approval state", async () => {
    const plans = new Plans(join(dir, "plans"));
    await plans.write("a", "1", "b");
    await plans.write("b", "2", "b");
    await plans.approve("b");
    const listed = await plans.list();
    expect(listed.map((plan) => [plan.slug, plan.approvedAt !== undefined])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  test("an empty or missing plans directory lists nothing", async () => {
    expect(await new Plans(join(dir, "absent")).list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

async function gitRepo(): Promise<string> {
  const root = join(dir, "repo");
  await mkdir(root, { recursive: true });
  await gitRun(["init", "-q"], root);
  await gitRun(["config", "user.email", "test@example.com"], root);
  await gitRun(["config", "user.name", "Test"], root);
  await gitRun(["config", "commit.gpgsign", "false"], root);
  await writeFile(join(root, "a.txt"), "one\n", "utf8");
  await gitRun(["add", "-A"], root);
  await gitRun(["commit", "-qm", "init"], root);
  return root;
}

describe("git operations", () => {
  test("a staged diff includes a file that did not exist before", async () => {
    const root = await gitRepo();
    await writeFile(join(root, "a.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(root, "brand-new.txt"), "hello\n", "utf8");

    await stageAll(root);
    const diff = await stagedDiff(root, "HEAD");

    expect(diff.filesChanged).toBe(2);
    // The reason staging happens before review: an untracked file is invisible to
    // `git diff` on the working tree, and a new file is a prime thing to review.
    expect(diff.patch).toContain("brand-new.txt");
    expect(diff.patch).toContain("hello");
    expect(diff.truncated).toBe(false);
  });

  test("a deletion shows up too", async () => {
    const root = await gitRepo();
    await unlink(join(root, "a.txt"));
    await stageAll(root);
    const diff = await stagedDiff(root, "HEAD");
    expect(diff.deletions).toBe(1);
  });

  test("a large diff is truncated but the whole patch is saved", async () => {
    const root = await gitRepo();
    await writeFile(join(root, "big.txt"), `${"x".repeat(400)}\n`.repeat(50), "utf8");
    await stageAll(root);
    const saved = join(dir, "diff.patch");
    const diff = await stagedDiff(root, "HEAD", { maxBytes: 500, saveTo: saved });

    expect(diff.truncated).toBe(true);
    expect(diff.patch).toContain("truncated");
    expect((await readFile(saved, "utf8")).length).toBeGreaterThan(500);
  });

  test("committing nothing is a no-op, not a failure", async () => {
    const root = await gitRepo();
    await stageAll(root);
    const nothing = await commitStaged(root, "no change");
    expect(nothing.committed).toBe(false);
    expect(nothing.reason).toContain("nothing staged");
  });

  test("committing a staged change records it", async () => {
    const root = await gitRepo();
    await writeFile(join(root, "b.txt"), "b\n", "utf8");
    await stageAll(root);
    const result = await commitStaged(root, "add b");
    expect(result.committed).toBe(true);
    expect(result.sha).toBeTruthy();

    // And the diff against the parent is now clean.
    const after = await stagedDiff(root, "HEAD");
    expect(after.filesChanged).toBe(0);
  });

  test("the pull request body is written outside the worktree", async () => {
    const root = await gitRepo();
    const bodyPath = join(dir, "run", "pr-body.md");

    // `gh` will fail here, but the body must already be on disk by then: the caller needs
    // the artifact regardless of whether the pull request could be opened.
    await openPullRequest({
      cwd: root,
      title: "t",
      body: "## why\n\nbecause",
      bodyPath,
      base: "main",
      head: "feat/x",
    }).catch(() => undefined);

    expect(await readFile(bodyPath, "utf8")).toContain("because");
  });
});

// ---------------------------------------------------------------------------

describe("review task", () => {
  const diff = {
    patch: "--- a/x\n+++ b/x\n+hello",
    truncated: false,
    filesChanged: 1,
    additions: 1,
    deletions: 0,
  };

  test("carries the plan, the diff, and the verdict format", () => {
    const task = buildReviewTask({
      targetRunId: "implementer-1",
      base: "main",
      diff,
      planBody: "## Contract\n- add x",
    });
    expect(task).toContain("implementer-1");
    expect(task).toContain("- add x");
    expect(task).toContain("+hello");
    expect(task).toContain("VERDICT: PASS");
    expect(task).toContain("must not edit");
  });

  test("says when the diff was cut short, and where the rest is", () => {
    const task = buildReviewTask({
      targetRunId: "r",
      base: "main",
      diff: { ...diff, truncated: true, path: "/state/runs/r/diff.patch" },
    });
    expect(task).toContain("truncated");
    expect(task).toContain("/state/runs/r/diff.patch");
  });

  test("an empty diff does not produce a broken code fence", () => {
    const task = buildReviewTask({
      targetRunId: "r",
      base: "main",
      diff: { ...diff, patch: "", filesChanged: 0, additions: 0 },
    });
    expect(task).toContain("(empty)");
  });
});
