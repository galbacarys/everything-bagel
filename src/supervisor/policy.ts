/**
 * The tool policy: what each role is allowed to do.
 *
 * This file is the enforcement point for the design's central claim. `--no-builtin-tools`
 * removes `bash`, `edit`, and `write`, and `--tools` narrows what remains to an explicit
 * allowlist. A supervisor cannot delete a branch because there is no verb for it, not
 * because a prompt asks it to behave.
 *
 * Empirically established, and both facts matter:
 *   - `--tools` re-enables a built-in that `--no-builtin-tools` disabled, so `read` can
 *     be kept for planning without keeping the run of them.
 *   - `--tools` is also an allowlist over *extension* tools, so the extension's own
 *     verb names must be listed or they are registered but inactive.
 */

import type { ModelChoice } from "../config.ts";
import type { Role } from "../domain/types.ts";

export interface ToolPolicy {
  /** Absolute path to the bagel extension. */
  extension: string;
  /** Disable every built-in tool before the allowlist is applied. */
  noBuiltinTools: boolean;
  /** Comma-separated allowlist of tool names and patterns. */
  allowlist: string;
}

/** Verbs the supervisor gets, by prefix plus the two privileged singletons. */
const SUPERVISOR_VERBS = "backlog_*,notebook_*,plan_write,gate_request";

/**
 * The supervisor keeps `read` and nothing else built-in.
 *
 * Planning needs to see the code, and reading is neither mutating nor executing, so
 * denying it would make plans worse without making anything safer. `bash`/`edit`/`write`
 * are the verbs that need to be absent, and they are.
 */
export function toolPolicyFor(role: Role, extensionPath: string): ToolPolicy {
  if (role === "supervisor") {
    return {
      extension: extensionPath,
      noBuiltinTools: true,
      allowlist: `read,${SUPERVISOR_VERBS}`,
    };
  }

  // Workers still get the ordinary coding tools; they are the ones supposed to be
  // editing files. What they do not get is the coordination plane beyond reading it.
  return {
    extension: extensionPath,
    noBuiltinTools: false,
    allowlist: `*,${SUPERVISOR_VERBS}`,
  };
}

/**
 * Model defaults. Exactly two levels, on purpose: a supervisor that plans, and workers
 * that execute. More tiers than that is a tuning problem pretending to be a feature.
 */
export const MODEL_DEFAULTS = {
  supervisor: { thinking: "high" } as ModelChoice,
  implementer: { thinking: "low" } as ModelChoice,
  reviewer: { thinking: "medium" } as ModelChoice,
} satisfies Record<string, ModelChoice>;
