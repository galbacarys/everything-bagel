/**
 * Plans, and the grant that approving one issues.
 *
 * A plan is a contract, and `approvedAt` is the permission to act on it. This is the
 * mechanical enforcement of "never implement without permission": a plan file carries its
 * own approval, and dispatch refuses a plan that does not have one. Nothing here trusts
 * the supervisor's memory of whether a human said yes.
 *
 * Stored as markdown with frontmatter so a plan stays readable and diffable, and so
 * approval is a visible edit rather than a row in a database nobody can inspect.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plan } from "../domain/types.ts";
import { parseFrontmatter, renderFrontmatter, toSlug } from "../util/frontmatter.ts";

export class PlanNotApprovedError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`plan "${slug}" has not been approved; request a plan gate and wait for a human`);
    this.name = "PlanNotApprovedError";
    this.slug = slug;
  }
}

export class Plans {
  readonly #dir: string;

  constructor(plansDir: string) {
    this.#dir = plansDir;
  }

  get dir(): string {
    return this.#dir;
  }

  pathFor(slug: string): string {
    return join(this.#dir, `${toSlug(slug)}.md`);
  }

  /** Write a plan, replacing any earlier draft of the same slug. */
  async write(slug: string, taskId: string | undefined, body: string): Promise<Plan> {
    const safe = toSlug(slug);
    await mkdir(this.#dir, { recursive: true });

    const existing = await this.get(safe);
    const path = this.pathFor(safe);
    const text = renderFrontmatter(
      {
        slug: safe,
        task: taskId,
        written: new Date().toISOString(),
        // Approval survives a rewrite, so re-presenting a plan does not silently revoke
        // a human's decision. A materially different plan should get a new slug.
        approved: existing?.approvedAt ? new Date(existing.approvedAt).toISOString() : undefined,
      },
      body,
    );
    await writeFile(path, text, "utf8");

    return {
      slug: safe,
      taskId: taskId ?? "",
      path,
      body,
      ...(existing?.approvedAt ? { approvedAt: existing.approvedAt } : {}),
    };
  }

  async get(slug: string): Promise<Plan | undefined> {
    const safe = toSlug(slug);
    const path = this.pathFor(safe);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }

    const { fields, body } = parseFrontmatter(text);
    const approved = fields["approved"] ? Date.parse(fields["approved"]) : Number.NaN;
    return {
      slug: safe,
      taskId: fields["task"] ?? "",
      path,
      body,
      ...(Number.isFinite(approved) ? { approvedAt: approved } : {}),
    };
  }

  async list(): Promise<Plan[]> {
    let names: string[];
    try {
      names = (await readdir(this.#dir)).filter((name) => name.endsWith(".md"));
    } catch {
      return [];
    }
    const plans = await Promise.all(names.map((name) => this.get(name.replace(/\.md$/, ""))));
    return plans
      .filter((plan): plan is Plan => plan !== undefined)
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Record a human's approval. Idempotent: approving twice keeps the first timestamp, so
   * the grant cannot be quietly extended by re-approving.
   */
  async approve(slug: string, at: number = Date.now()): Promise<Plan> {
    const plan = await this.get(slug);
    if (!plan) throw new Error(`no plan at ${this.pathFor(slug)}`);

    if (plan.approvedAt) return plan;

    const { fields } = parseFrontmatter(await readFile(plan.path, "utf8"));
    await writeFile(
      plan.path,
      renderFrontmatter(
        { ...fields, approved: new Date(at).toISOString() },
        plan.body,
      ),
      "utf8",
    );
    return { ...plan, approvedAt: at };
  }

  /** The gate dispatch passes through. Throws rather than returning a boolean, so a
   *  caller cannot accidentally proceed on a falsy value. */
  async requireApproved(slug: string): Promise<Plan> {
    const plan = await this.get(slug);
    if (!plan) throw new Error(`no plan at ${this.pathFor(slug)}; write it with plan_write first`);
    if (!plan.approvedAt) throw new PlanNotApprovedError(plan.slug);
    return plan;
  }
}
