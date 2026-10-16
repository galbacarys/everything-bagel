/**
 * Layout primitives.
 *
 * Width handling goes through pi-tui rather than `string.length`, because ANSI
 * escapes, wide characters, emoji, and combining marks all change display width.
 * Never measure a string with `.length` in this codebase.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FrameStyle } from "./style.ts";

export const ELLIPSIS = "…";

/**
 * Draw a titled box of exactly `width` x `height` terminal cells around `body`.
 * Returns [] when the box cannot fit, so callers can degrade instead of throwing.
 */
export function frame(
  title: string,
  body: string[],
  width: number,
  height: number,
  style: FrameStyle,
): string[] {
  if (width < 6 || height < 2) return [];

  const innerWidth = width - 2;
  const contentWidth = width - 4;
  const innerHeight = height - 2;

  const out: string[] = [];

  // Top border, with the title embedded after a single leading dash.
  const rawLabel = title ? ` ${title} ` : "";
  const label = truncateToWidth(rawLabel, Math.max(0, innerWidth - 2), ELLIPSIS, false);
  const labelWidth = visibleWidth(label);
  const trail = Math.max(0, innerWidth - 1 - labelWidth);
  out.push(style.border("╭─") + style.title(label) + style.border(`${"─".repeat(trail)}╮`));

  // Body rows, padded to exactly contentWidth visible cells.
  for (let i = 0; i < innerHeight; i++) {
    const line = body[i] ?? "";
    out.push(
      style.border("│") +
        " " +
        truncateToWidth(line, contentWidth, ELLIPSIS, true) +
        " " +
        style.border("│"),
    );
  }

  out.push(style.border(`╰${"─".repeat(innerWidth)}╯`));
  return out;
}

/**
 * Place frames side by side. Every input line is already exactly its frame's
 * width, so this only has to zipper them with a gap.
 */
export function columns(left: string[], right: string[], gap = 1): string[] {
  const rows = Math.max(left.length, right.length);
  const gutter = " ".repeat(gap);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push((left[i] ?? "") + gutter + (right[i] ?? ""));
  }
  return out;
}

/** Pad or clip a block of lines to an exact height. */
export function fitHeight(lines: string[], height: number): string[] {
  if (lines.length === height) return lines;
  if (lines.length > height) return lines.slice(lines.length - height);
  return [...lines, ...Array.from({ length: height - lines.length }, () => "")];
}

/**
 * Keep the tail of a list so it occupies at most `height` rows. Used by the
 * scrolling panes (supervisor transcript, notebook) so newest output stays visible.
 */
export function tail(lines: string[], height: number): string[] {
  return lines.length <= height ? lines : lines.slice(lines.length - height);
}

/** A horizontal rule that spans exactly `width` cells. */
export function rule(width: number, style: (text: string) => string): string {
  return style("─".repeat(Math.max(0, width)));
}

/** Two-column label/value row, right-aligned value. */
export function spread(
  left: string,
  right: string,
  width: number,
  styleRight: (text: string) => string = (t) => t,
): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const gap = Math.max(1, width - leftWidth - rightWidth);
  return truncateToWidth(left, Math.max(0, width - rightWidth - 1), ELLIPSIS, false) +
    " ".repeat(gap) +
    styleRight(right);
}
