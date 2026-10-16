/**
 * Gates: the two places a human is actually needed.
 *
 * The supervisor blocks on a gate by calling a tool. The tool call travels over the
 * bridge and parks here until a human answers in bagel's own UI. Nothing else in the
 * lifecycle asks for permission — that is the whole point of approving a plan once.
 *
 * A gate always settles. A forgotten prompt, an aborted run, or a disconnected bridge
 * all resolve it as declined, so a supervisor can never hang forever waiting for an
 * answer that is not coming.
 */

import type { Bus } from "../domain/events.ts";
import type { GateRequest } from "../domain/types.ts";

export interface PendingGate extends GateRequest {
  requestedAt: number;
}

export interface GateDecision {
  accepted: boolean;
  /** Why, when the answer is not a simple yes or no. */
  note?: string;
}

export interface GateQueueOptions {
  bus: Bus;
  /** How long a gate waits before declining itself. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class GateQueue {
  readonly #bus: Bus;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingGate>();
  readonly #settlers = new Map<string, (decision: GateDecision) => void>();
  #counter = 0;

  constructor(options: GateQueueOptions) {
    this.#bus = options.bus;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** How many gates are waiting. */
  get count(): number {
    return this.#pending.size;
  }

  /** The gate to show a human: the oldest unsettled one. */
  get current(): PendingGate | undefined {
    return [...this.#pending.values()].sort((a, b) => a.requestedAt - b.requestedAt)[0];
  }

  /**
   * Park until answered. `signal` is the bridge request's signal, so a run that goes
   * away takes its gate with it.
   */
  async request(request: Omit<GateRequest, "id">, signal?: AbortSignal): Promise<GateDecision> {
    this.#counter += 1;
    const gate: PendingGate = { ...request, id: `gate-${this.#counter}`, requestedAt: Date.now() };
    this.#pending.set(gate.id, gate);
    this.#bus.emit({ type: "gate.requested", request: gate });

    return await new Promise<GateDecision>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (decision: GateDecision): void => {
        // Settling twice is a no-op: the timer, the abort signal, and a human answer
        // all race, and only the first should count.
        if (!this.#pending.has(gate.id)) return;
        this.#pending.delete(gate.id);
        this.#settlers.delete(gate.id);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#bus.emit({ type: "gate.resolved", id: gate.id, accepted: decision.accepted });
        resolve(decision);
      };

      const onAbort = (): void => {
        settle({ accepted: false, note: "the run that asked for this was aborted" });
      };

      this.#settlers.set(gate.id, settle);

      timer = setTimeout(() => {
        settle({
          accepted: false,
          note: `nobody answered within ${Math.round(this.#timeoutMs / 60_000)} minutes`,
        });
      }, this.#timeoutMs);
      timer.unref?.();

      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Answer a gate. Returns false when it was already settled. */
  resolve(id: string, decision: GateDecision): boolean {
    const settle = this.#settlers.get(id);
    if (!settle) return false;
    settle(decision);
    return true;
  }

  /** Decline everything outstanding, e.g. on shutdown. */
  cancelAll(note: string): void {
    for (const settle of [...this.#settlers.values()]) {
      settle({ accepted: false, note });
    }
  }
}
