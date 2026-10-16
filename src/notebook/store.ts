/**
 * The engineer's notebook: personal, local, append-only.
 *
 * Two surfaces, one store:
 *   - `journal.jsonl` — immutable record of what happened. Never edited; a
 *     correction is a new entry carrying `supersedes`.
 *   - `docs/*.md`     — living distilled truth per subsystem, rewritten in place.
 *
 * The journal is what makes a new session cheap to start: `recall()` returns the
 * recent tail and keyword matches, which the supervisor gets primed with. Since
 * the store is personal there is exactly one writer, so appends need no locking.
 */

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EntryId, EntryKind, JournalEntry } from "../domain/types.ts";

export interface AppendInput {
  actor: JournalEntry["actor"];
  kind: EntryKind;
  body: string;
  tags?: string[];
  taskId?: string;
  supersedes?: EntryId;
}

export interface RecallResult {
  /** Most recent entries, oldest first. */
  recent: JournalEntry[];
  /** Entries whose body or tags match any term, newest first. */
  matches: JournalEntry[];
  /** Headings from living docs, so the supervisor knows what exists. */
  docIndex: Array<{ name: string; headings: string[] }>;
}

export class Notebook {
  readonly journalPath: string;
  readonly docsDir: string;
  #counter = 0;

  constructor(journalPath: string, docsDir: string) {
    this.journalPath = journalPath;
    this.docsDir = docsDir;
  }

  #nextId(): EntryId {
    // Monotonic within a process; combined with the timestamp it is unique enough
    // for an append-only personal log.
    this.#counter += 1;
    return `${Date.now().toString(36)}-${this.#counter.toString(36)}`;
  }

  async append(input: AppendInput): Promise<JournalEntry> {
    const entry: JournalEntry = {
      id: this.#nextId(),
      at: Date.now(),
      actor: input.actor,
      kind: input.kind,
      body: input.body,
      tags: input.tags ?? [],
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    await mkdir(dirname(this.journalPath), { recursive: true });
    await appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  async #readAll(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.journalPath, "utf8");
    } catch {
      return [];
    }
    const entries: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // A torn final line (process killed mid-write) is expected; skip it.
      }
    }
    return entries;
  }

  /** Most recent `limit` entries, oldest first. */
  async tail(limit = 40): Promise<JournalEntry[]> {
    const all = await this.#readAll();
    return all.slice(-limit);
  }

  async search(terms: string, limit = 20): Promise<JournalEntry[]> {
    const needles = terms
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (!needles.length) return [];
    const all = await this.#readAll();
    const scored: Array<{ entry: JournalEntry; score: number }> = [];
    for (const entry of all) {
      const haystack = `${entry.body} ${entry.tags.join(" ")} ${entry.kind}`.toLowerCase();
      const score = needles.reduce((acc, n) => (haystack.includes(n) ? acc + 1 : acc), 0);
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.at - a.entry.at);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /** Markdown headings of every living doc, for priming and for the UI. */
  async docIndex(): Promise<Array<{ name: string; headings: string[] }>> {
    let names: string[];
    try {
      names = (await readdir(this.docsDir)).filter((n) => n.endsWith(".md"));
    } catch {
      return [];
    }
    const out: Array<{ name: string; headings: string[] }> = [];
    for (const name of names.sort()) {
      try {
        const text = await readFile(join(this.docsDir, name), "utf8");
        out.push({
          name,
          headings: text
            .split("\n")
            .filter((l) => l.startsWith("#"))
            .map((l) => l.replace(/^#+\s*/, "").trim()),
        });
      } catch {
        // Unreadable doc is not worth failing the whole recall for.
      }
    }
    return out;
  }

  /**
   * Everything a fresh session needs to know, kept small on purpose: the recent
   * tail plus anything matching the current task, never the whole journal.
   */
  async recall(options: { recent?: number; terms?: string } = {}): Promise<RecallResult> {
    const [recent, matches, docIndex] = await Promise.all([
      this.tail(options.recent ?? 25),
      options.terms ? this.search(options.terms) : Promise.resolve([]),
      this.docIndex(),
    ]);
    return { recent, matches, docIndex };
  }

  /** Render a recall result as the priming block injected into a new session. */
  static formatRecall(result: RecallResult, now: number): string {
    const stamp = (at: number) => new Date(at).toISOString().slice(11, 16);
    const lines: string[] = ["## Notebook recall", ""];

    if (result.docIndex.length) {
      lines.push("Living docs (read these before re-deriving anything):");
      for (const doc of result.docIndex) {
        lines.push(`- ${doc.name}${doc.headings.length ? ` — ${doc.headings.slice(0, 6).join(" / ")}` : ""}`);
      }
      lines.push("");
    }

    if (result.matches.length) {
      lines.push("Related to the current task:");
      for (const entry of result.matches.slice(0, 10)) {
        lines.push(`- ${stamp(entry.at)} [${entry.kind}] ${oneLine(entry.body)}`);
      }
      lines.push("");
    }

    if (result.recent.length) {
      lines.push("Recent journal:");
      for (const entry of result.recent) {
        lines.push(`- ${stamp(entry.at)} [${entry.kind}] ${oneLine(entry.body)}`);
      }
      lines.push("");
    }

    if (lines.length <= 3) return "";
    lines.push(`(recall generated ${new Date(now).toISOString()})`);
    return lines.join("\n");
  }
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
