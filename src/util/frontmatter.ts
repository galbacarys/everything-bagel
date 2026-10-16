/**
 * Minimal `---` delimited frontmatter.
 *
 * Deliberately not a YAML parser. It handles `key: value`, ignores comments, and strips
 * surrounding quotes, which is everything bagel's own files need. A real YAML dependency
 * would buy expressiveness that nothing here uses and one more way for a hand-edited file
 * to surprise us.
 */

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { fields: {}, body: normalized.trim() };

  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, body: normalized.trim() };

  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match?.[1]) continue;
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value) fields[match[1]] = value;
  }

  return { fields, body: normalized.slice(end + 4).trim() };
}

/** Render frontmatter followed by the body. Empty values are omitted entirely. */
export function renderFrontmatter(fields: Record<string, string | number | undefined>, body: string): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${value}`);

  const head = lines.length ? `---\n${lines.join("\n")}\n---\n` : "";
  return `${head}${body.endsWith("\n") ? body : `${body}\n`}`;
}

/**
 * A filename-safe slug. Used for branch names and plan files, where a value that escapes
 * its directory or produces an illegal git ref is worse than an ugly one.
 */
export function toSlug(raw: string, fallback = "task"): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || fallback;
}
