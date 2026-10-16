/**
 * Role definitions: what a worker of each kind is for, and how it is configured.
 *
 * Stored as markdown with YAML-ish frontmatter so they are hand-editable and diffable,
 * and so a user can retune a role — swap the model, narrow the tools, add a paragraph of
 * guidance — without touching code. Defaults are written to disk on first run rather than
 * kept in memory, because a setting nobody can find is a setting nobody will change.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "../domain/types.ts";

export interface RoleDefinition {
  role: Role;
  /** Model pattern, e.g. `openrouter/~deepseek/deepseek-flash-latest`. */
  model?: string;
  provider?: string;
  thinking?: string;
  /** Tools this worker may use. Empty means the role default from policy.ts. */
  tools?: string[];
  /** Extra guidance appended to the worker's system prompt. */
  instructions: string;
  /** Where it came from, for diagnostics. */
  source: "default" | "file";
  path?: string;
}

/** Roles that can actually be dispatched. The supervisor is not one of them. */
export const WORKER_ROLES: Role[] = ["implementer", "reviewer", "scout"];

const DEFAULTS: Record<string, { frontmatter: string[]; body: string }> = {
  implementer: {
    frontmatter: ["thinking: low"],
    body: [
      "You implement exactly one approved plan, in your own git worktree.",
      "",
      "Rules:",
      "- Implement the plan. Do not widen the scope, and do not restructure things it did",
      "  did not ask for.",
      "- Work only inside your working directory, which is the worktree root. Never touch",
      "  the main checkout or another run's worktree.",
      "- Run the verification commands the task names, and paste their real output.",
      "- If the plan is impossible or self-contradictory, stop and say so with the exact",
      "  error, rather than improvising a different task.",
      "- If the same lookup fails twice, stop and report the blocker.",
      "- Do not push, do not open a pull request, and do not apply migrations.",
      "",
      "Finish with a short report: files changed, commands run and their results, anything",
      "unfinished, and any blockers.",
    ].join("\n"),
  },
  reviewer: {
    frontmatter: ["thinking: medium"],
    body: [
      "You review a change you did not write, and you never edit it.",
      "",
      "Your job is to answer one question: does this change actually do what it claims?",
      "Check the claim, not just the style.",
      "",
      "Rules:",
      "- Read the diff and the plan it came from. Every changed file must be justified by",
      "  the plan; flag stray changes.",
      "- Check every state, not just the happy path: initial, loading, empty, error,",
      "  permission-denied, partial, repeated, concurrent. A path that can render a wrong,",
      "  degraded, or misleading state is a blocker, not a nit.",
      "- Nits are not blockers. Do not block on style.",
      "- Say when you cannot verify something instead of guessing.",
      "",
      "Write your verdict as the first line of your report: `VERDICT: PASS` or",
      "`VERDICT: BLOCK`, followed by the reasons.",
    ].join("\n"),
  },
  scout: {
    frontmatter: ["thinking: low"],
    body: [
      "You answer a specific question about the codebase and report back. You change",
      "nothing.",
      "",
      "Be concrete: name files, functions, and line numbers. If the question is ambiguous,",
      "answer the most likely reading and say what you assumed.",
    ].join("\n"),
  },
};

/** Parse `---` delimited frontmatter. Deliberately minimal: `key: value` only. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { fields: {}, body: normalized.trim() };

  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, body: normalized.trim() };

  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match?.[1]) continue;
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value) fields[match[1]] = value;
  }

  const body = normalized.slice(end + 4).trim();
  return { fields, body };
}

function fromFile(role: Role, path: string, text: string): RoleDefinition {
  const { fields, body } = parseFrontmatter(text);
  return {
    role,
    ...(fields["model"] ? { model: fields["model"] } : {}),
    ...(fields["provider"] ? { provider: fields["provider"] } : {}),
    ...(fields["thinking"] ? { thinking: fields["thinking"] } : {}),
    ...(fields["tools"] ? { tools: fields["tools"].split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    instructions: body || DEFAULTS[role]?.body || "",
    source: "file",
    path,
  };
}

function asDefault(role: Role): RoleDefinition {
  const spec = DEFAULTS[role];
  const fields = parseFrontmatter(`---\n${(spec?.frontmatter ?? []).join("\n")}\n---\n`).fields;
  return {
    role,
    ...(fields["thinking"] ? { thinking: fields["thinking"] } : {}),
    instructions: spec?.body ?? "",
    source: "default",
  };
}

/**
 * Write the default role files if they are not already there.
 *
 * Only creates; never overwrites. A user who has edited a role must not have it
 * silently replaced on the next launch.
 */
export async function ensureRoleFiles(rolesDir: string): Promise<string[]> {
  await mkdir(rolesDir, { recursive: true });
  const written: string[] = [];
  for (const role of WORKER_ROLES) {
    const spec = DEFAULTS[role];
    if (!spec) continue;
    const path = join(rolesDir, `${role}.md`);
    try {
      await readFile(path, "utf8");
      continue;
    } catch {
      // Not there yet, so write the default.
    }
    const header = [
      "---",
      ...spec.frontmatter,
      "# Uncomment to pin a model for this role. Empty means the implementer tier default.",
      "# model: openrouter/~deepseek/deepseek-flash-latest",
      "# provider: openrouter",
      "---",
      "",
    ].join("\n");
    await writeFile(path, `${header}${spec.body}\n`, "utf8");
    written.push(path);
  }
  return written;
}

/** Load a role, falling back to the built-in default when no file exists. */
export async function loadRole(rolesDir: string, role: Role): Promise<RoleDefinition> {
  const path = join(rolesDir, `${role}.md`);
  try {
    return fromFile(role, path, await readFile(path, "utf8"));
  } catch {
    return asDefault(role);
  }
}

export async function loadAllRoles(rolesDir: string): Promise<Record<string, RoleDefinition>> {
  const out: Record<string, RoleDefinition> = {};
  for (const role of WORKER_ROLES) {
    out[role] = await loadRole(rolesDir, role);
  }
  return out;
}
