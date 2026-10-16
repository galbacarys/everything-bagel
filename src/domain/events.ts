/**
 * The narrow waist of the program.
 *
 * Producers (pi sessions, trackers, the notebook, the gate handler) emit domain
 * events. Consumers (the UI, and later the notebook writer) listen. Neither side
 * knows about the other, and neither side knows about pi.
 */

import type { AgentRun, GateRequest, JournalEntry, Task } from "./types.ts";

export type DomainEvent =
  // Execution plane
  | { type: "run.started"; run: AgentRun }
  | { type: "run.updated"; run: AgentRun }
  | { type: "run.delta"; runId: string; text: string }
  | { type: "run.tool"; runId: string; tool: string }
  | { type: "run.settled"; run: AgentRun }
  | { type: "run.failed"; runId: string; error: string }
  // Coordination plane
  | { type: "backlog.updated"; tasks: Task[] }
  // Memory plane
  | { type: "notebook.appended"; entry: JournalEntry }
  // Gates
  | { type: "gate.requested"; request: GateRequest }
  | { type: "gate.resolved"; id: string; accepted: boolean }
  // App-level
  | { type: "notice"; level: "info" | "warn" | "error"; message: string };

export type DomainEventType = DomainEvent["type"];

export type Listener = (event: DomainEvent) => void;

export class Bus {
  #listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: DomainEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        // A misbehaving listener must never take down the event loop that pi's
        // stream is flowing through.
        console.error("[bagel] listener threw", error);
      }
    }
  }
}
