/**
 * The root component. bagel owns the whole screen: one render pass composes a
 * header, a 2x2 pane grid, and an input line.
 *
 * Design notes:
 *   - Panes are pure functions in ./panes.ts. This class owns state and input, so a
 *     render pass can never start a side effect.
 *   - Only pi-tui's Markdown component is stateful, and only because it caches
 *     parsed tokens by width. It is kept here rather than rebuilt per frame.
 *   - Nothing here imports from `pi/` or `tracker/`. State arrives as domain events.
 */

import { Input, Key, Markdown, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Bus, DomainEvent } from "../domain/events.ts";
import type { AgentRun, GateRequest } from "../domain/types.ts";
import { columns, frame } from "./layout.ts";
import {
  agentsContent,
  backlogContent,
  headerLine,
  notebookContent,
  type FocusTarget,
  type PaneId,
  type PaneState,
} from "./panes.ts";
import { dim, focusedFrameStyle, frameStyle, markdownTheme, palette, type FrameStyle } from "./style.ts";

export interface AppOptions {
  bus: Bus;
  /** Terminal row count. `Component.render` only receives width. */
  height: () => number;
  requestRender: () => void;
  repoId: string;
  session: string;
}

const PANE_ORDER: PaneId[] = ["backlog", "supervisor", "agents", "notebook"];
const FOCUS_ORDER: FocusTarget[] = ["prompt", ...PANE_ORDER];

const MAX_JOURNAL = 200;
const MAX_SUPERVISOR_TEXT = 200_000;

export class App implements Component {
  #state: PaneState;
  #input: Input;
  #markdown: Markdown;
  #markdownSource = "\u0000";
  #height: () => number;
  #requestRender: () => void;
  #repoId: string;
  #session: string;
  #supervisorText = "";
  #supervisorRunId: string | undefined;
  #notice: { level: "info" | "warn" | "error"; message: string } | undefined;
  /** Gates awaiting an answer, oldest first. The input line is replaced while one is open. */
  #gates: GateRequest[] = [];
  #focused = false;
  #unsubscribe: () => void;

  onSubmit?: (text: string) => void;
  onQuit?: () => void;
  /** Called when a human answers a gate. bagel owns the pending gate, not the UI. */
  onGateAnswer?: (id: string, accepted: boolean) => void;

  constructor(options: AppOptions) {
    this.#height = options.height;
    this.#requestRender = options.requestRender;
    this.#repoId = options.repoId;
    this.#session = options.session;

    this.#state = {
      tasks: [],
      runs: [],
      journal: [],
      claims: new Map(),
      trackerName: "connecting…",
      trackerLive: false,
      selectedTask: 0,
      focus: "prompt",
      supervisorBusy: false,
    };

    this.#input = new Input({
      prompt: palette.accent("▌ "),
      placeholder: "ask the supervisor…",
      placeholderStyle: (text) => dim(text),
    });
    this.#input.onSubmit = (value: string): void => {
      const text = value.trim();
      if (!text) return;
      this.#input.setValue("");
      this.onSubmit?.(text);
      this.#requestRender();
    };

    this.#markdown = new Markdown("", 0, 0, markdownTheme);
    this.#unsubscribe = options.bus.on((event) => this.#apply(event));
  }

  // -- Focusable ------------------------------------------------------------

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value;
  }

  dispose(): void {
    this.#unsubscribe();
  }

  invalidate(): void {
    this.#input.invalidate();
    this.#markdown.invalidate();
  }

  // -- domain events --------------------------------------------------------

  #apply(event: DomainEvent): void {
    switch (event.type) {
      case "run.started":
      case "run.updated":
      case "run.settled": {
        this.#upsertRun(event.run);
        if (event.run.role === "supervisor") {
          this.#supervisorRunId = event.run.id;
          this.#state.supervisorBusy = event.run.status === "running";
        }
        break;
      }

      case "run.failed": {
        if (event.runId === this.#supervisorRunId) this.#state.supervisorBusy = false;
        this.#notice = { level: "error", message: event.error };
        break;
      }

      case "run.delta": {
        if (event.runId !== this.#supervisorRunId) break;
        this.#supervisorText += event.text;
        if (this.#supervisorText.length > MAX_SUPERVISOR_TEXT) {
          this.#supervisorText = this.#supervisorText.slice(-MAX_SUPERVISOR_TEXT);
        }
        break;
      }

      case "run.tool": {
        // Tool activity already lands in the run via run.updated.
        break;
      }

      case "backlog.updated": {
        this.#state.tasks = event.tasks;
        this.#state.claims = new Map(event.claims.map((claim) => [claim.taskId, claim]));
        this.#state.trackerLive = true;
        this.#state.trackerDetail = undefined;
        const max = Math.max(0, event.tasks.length - 1);
        this.#state.selectedTask = Math.min(this.#state.selectedTask, max);
        break;
      }

      case "backlog.unavailable": {
        // Keep the last snapshot. A stale backlog is more useful than a blank pane.
        this.#state.trackerLive = false;
        this.#state.trackerDetail = event.reason;
        break;
      }

      case "tracker.status": {
        this.#state.trackerName = event.trackerName;
        this.#state.trackerLive = event.live;
        this.#state.trackerDetail = event.detail;
        break;
      }

      case "notebook.appended": {
        if (this.#state.journal.some((entry) => entry.id === event.entry.id)) break;
        this.#state.journal = [...this.#state.journal, event.entry].slice(-MAX_JOURNAL);
        break;
      }

      case "gate.requested": {
        if (!this.#gates.some((gate) => gate.id === event.request.id)) {
          this.#gates = [...this.#gates, event.request];
        }
        this.#notice = undefined;
        break;
      }

      case "gate.resolved": {
        this.#gates = this.#gates.filter((gate) => gate.id !== event.id);
        break;
      }

      case "notice": {
        this.#notice = { level: event.level, message: event.message };
        break;
      }
    }

    this.#requestRender();
  }

  #upsertRun(run: AgentRun): void {
    const index = this.#state.runs.findIndex((existing) => existing.id === run.id);
    const next = [...this.#state.runs];
    if (index >= 0) next[index] = { ...run };
    else next.push({ ...run });
    this.#state.runs = next;
  }

  // -- input ----------------------------------------------------------------

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.onQuit?.();
      return;
    }

    // A gate outranks everything except quitting: it is a blocking question, and the
    // run that asked is parked until it is answered. Tab still works, so panes stay
    // reachable while deciding.
    const gate = this.#gates[0];
    if (gate) {
      if (data === "y" || matchesKey(data, Key.enter)) {
        this.onGateAnswer?.(gate.id, true);
        return;
      }
      if (data === "n" || matchesKey(data, Key.escape)) {
        this.onGateAnswer?.(gate.id, false);
        return;
      }
      if (!matchesKey(data, Key.tab) && !matchesKey(data, Key.shift("tab"))) return;
    }

    if (matchesKey(data, Key.tab)) {
      this.#cycleFocus(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.#cycleFocus(-1);
      return;
    }

    if (this.#state.focus !== "prompt") {
      this.#handlePaneInput(data);
      return;
    }

    this.#input.handleInput(data);
    this.#requestRender();
  }

  #handlePaneInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "i") {
      this.#state.focus = "prompt";
      this.#requestRender();
      return;
    }
    if (data === "j" || matchesKey(data, Key.down)) {
      this.#moveSelection(1);
      return;
    }
    if (data === "k" || matchesKey(data, Key.up)) {
      this.#moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.#activateSelection();
      return;
    }
    if (data === "q") {
      this.onQuit?.();
    }
  }

  #cycleFocus(delta: number): void {
    const index = FOCUS_ORDER.indexOf(this.#state.focus);
    const next = (index + delta + FOCUS_ORDER.length) % FOCUS_ORDER.length;
    this.#state.focus = FOCUS_ORDER[next] ?? "prompt";
    this.#requestRender();
  }

  #moveSelection(delta: number): void {
    if (this.#state.focus === "backlog") {
      const count = this.#state.tasks.length;
      if (count > 0) {
        this.#state.selectedTask = Math.max(0, Math.min(count - 1, this.#state.selectedTask + delta));
      }
    }
    this.#requestRender();
  }

  /** Entering a task drops a question about it into the prompt line. */
  #activateSelection(): void {
    if (this.#state.focus === "backlog") {
      const task = this.#state.tasks[this.#state.selectedTask];
      if (task) this.#input.setValue(`#${task.id} ${task.title} — is this ready to start?`);
    }
    this.#state.focus = "prompt";
    this.#requestRender();
  }

  // -- render ---------------------------------------------------------------

  render(width: number): string[] {
    const screenWidth = Math.max(40, width);
    const screenHeight = Math.max(14, this.#height());

    const notice = this.#noticeLine(screenWidth);
    const gridHeight = Math.max(8, screenHeight - 2 - (notice ? 1 : 0));
    const topHeight = Math.max(5, Math.floor(gridHeight / 2));
    const bottomHeight = Math.max(5, gridHeight - topHeight);

    const leftWidth = Math.max(26, Math.floor(screenWidth * 0.42));
    const rightWidth = Math.max(24, screenWidth - leftWidth - 1);

    const top = columns(
      frame("backlog", backlogContent(this.#state, topHeight - 2), leftWidth, topHeight, this.#frameFor("backlog")),
      frame(
        this.#state.supervisorBusy ? "supervisor ●" : "supervisor",
        this.#supervisorLines(rightWidth - 4),
        rightWidth,
        topHeight,
        this.#frameFor("supervisor"),
      ),
    );

    const bottom = columns(
      frame("agents", agentsContent(this.#state, bottomHeight - 2), leftWidth, bottomHeight, this.#frameFor("agents")),
      frame(
        "notebook",
        notebookContent(this.#state, bottomHeight - 2),
        rightWidth,
        bottomHeight,
        this.#frameFor("notebook"),
      ),
    );

    const lines: string[] = [headerLine(this.#state, screenWidth, this.#repoId, this.#session)];
    if (notice) lines.push(notice);
    lines.push(...top, ...bottom);
    lines.push(this.#footerLine(screenWidth));

    return lines.slice(0, screenHeight);
  }

  /** The bottom line is the input, unless a gate has taken it over. */
  #footerLine(width: number): string {
    const gate = this.#gates[0];
    if (!gate) return this.#input.render(width)[0] ?? "";

    const more = this.#gates.length > 1 ? dim(`  (+${this.#gates.length - 1} more)`) : "";
    const line = [
      palette.warn("▌ "),
      palette.warn("DECIDE"),
      " ",
      truncateToWidth(gate.prompt, Math.max(10, width - 46), "…", false),
      dim("   "),
      palette.ok("[y]"),
      ` ${gate.accept}`,
      dim("   "),
      palette.err("[n]"),
      " decline",
    ].join("");
    return truncateToWidth(line + more, width, "…", true);
  }

  #frameFor(pane: PaneId): FrameStyle {
    return this.#state.focus === pane ? focusedFrameStyle : frameStyle;
  }

  #supervisorLines(width: number): string[] {
    const usable = Math.max(10, width);
    if (!this.#supervisorText.trim()) {
      const hint = this.#state.supervisorBusy
        ? "supervisor is thinking…"
        : "Type below to talk to the supervisor. tab moves between panes, j/k move, enter opens, i returns to typing.";
      return [dim(hint)];
    }
    if (this.#supervisorText !== this.#markdownSource) {
      this.#markdown.setText(this.#supervisorText);
      this.#markdownSource = this.#supervisorText;
    }
    return this.#markdown.render(usable);
  }

  #noticeLine(width: number): string | undefined {
    const notice = this.#notice;
    if (!notice) return undefined;
    const color =
      notice.level === "error" ? palette.err : notice.level === "warn" ? palette.warn : palette.muted;
    return truncateToWidth(` ${color(notice.message)}`, width, "…", true);
  }
}
