/**
 * Tests for the GitHub adapter's pure parts.
 *
 * These are the pieces most likely to break silently: URL parsing, dependency
 * conventions, and the claim marker round trip. Anything that needs the network is
 * exercised by `scripts/backlog.ts` instead.
 */

import { describe, expect, test } from "bun:test";
import type { Claim } from "../domain/types.ts";
import { isExpired } from "./adapter.ts";
import { parseBlockedBy, parseClaimMarker, parseRepoSlug, renderClaimMarker } from "./github.ts";

describe("parseRepoSlug", () => {
  test("https with and without .git", () => {
    expect(parseRepoSlug("https://github.com/owner/name.git")).toBe("owner/name");
    expect(parseRepoSlug("https://github.com/owner/name")).toBe("owner/name");
  });

  test("ssh scp syntax", () => {
    expect(parseRepoSlug("git@github.com:owner/name.git")).toBe("owner/name");
  });

  test("ssh url syntax and credentials in the url", () => {
    expect(parseRepoSlug("ssh://git@github.com/owner/name.git")).toBe("owner/name");
    expect(parseRepoSlug("https://token@github.com/owner/name.git")).toBe("owner/name");
  });

  test("self-hosted and nested groups keep the last two segments", () => {
    expect(parseRepoSlug("https://git.example.com/team/owner/name.git")).toBe("owner/name");
  });

  test("rejects things that are not repositories", () => {
    expect(parseRepoSlug("")).toBeUndefined();
    expect(parseRepoSlug("name")).toBeUndefined();
  });
});

describe("parseBlockedBy", () => {
  test("reads the supported conventions", () => {
    expect(parseBlockedBy("Blocked by #12")).toEqual(["12"]);
    expect(parseBlockedBy("depends on #7")).toEqual(["7"]);
    expect(parseBlockedBy("Blocked-by: #3")).toEqual(["3"]);
  });

  test("reads lists, including prose separators", () => {
    expect(parseBlockedBy("Blocked by #12, #13 and #14")).toEqual(["12", "13", "14"]);
    expect(parseBlockedBy("blocked by #1, #2, and #3.")).toEqual(["1", "2", "3"]);
  });

  test("deduplicates and finds multiple lines", () => {
    expect(parseBlockedBy("blocked by #5\nDepends on #5\nrequires #6")).toEqual(["5", "6"]);
  });

  test("does not invent dependencies", () => {
    expect(parseBlockedBy("this was blocked by the weather")).toEqual([]);
    expect(parseBlockedBy("see #12 for context")).toEqual([]);
    expect(parseBlockedBy("")).toEqual([]);
  });
});

describe("claim markers", () => {
  const claim: Claim = {
    taskId: "41",
    session: "abc12345",
    runId: "implementer-1",
    acquiredAt: 1_700_000_000_000,
    ttlMs: 14_400_000,
    holder: "octocat",
  };

  test("round trip preserves identity and lifetime", () => {
    const parsed = parseClaimMarker(renderClaimMarker(claim));
    expect(parsed).toBeDefined();
    expect(parsed?.session).toBe("abc12345");
    expect(parsed?.runId).toBe("implementer-1");
    expect(parsed?.acquiredAt).toBe(1_700_000_000_000);
    expect(parsed?.ttlMs).toBe(14_400_000);
    expect(parsed?.holder).toBe("octocat");
  });

  test("survives a marker embedded in a longer, human-written comment", () => {
    const body = `Claimed by bagel session \`abc12345\`\n\n${renderClaimMarker(claim)}\n\nSome trailing prose with #12 in it.`;
    expect(parseClaimMarker(body)?.session).toBe("abc12345");
  });

  test("ignores unrelated comments", () => {
    expect(parseClaimMarker("just a normal comment")).toBeUndefined();
    expect(parseClaimMarker("<!-- bagel:claim not-json -->")).toBeUndefined();
    expect(parseClaimMarker("<!-- bagel:claim {} -->")).toBeUndefined();
  });

  test("expiry is based on the TTL", () => {
    const now = 1_700_000_000_000;
    expect(isExpired(claim, now)).toBe(false);
    expect(isExpired(claim, now + claim.ttlMs - 1)).toBe(false);
    expect(isExpired(claim, now + claim.ttlMs + 1)).toBe(true);
    // A zero TTL means "no expiry" rather than "already expired".
    expect(isExpired({ ...claim, ttlMs: 0 }, now + 10 ** 12)).toBe(false);
  });
});
