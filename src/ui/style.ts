/**
 * bagel's own palette and the markdown theme handed to pi-tui's Markdown renderer.
 *
 * The palette is deliberately warm and low-contrast; it is tuned for long sessions.
 * pi-tui resets styling after every rendered line, so every helper here is a
 * self-contained wrapper that also resets.
 */

import type { MarkdownTheme } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";

/** 24-bit foreground. */
export const fg =
  (r: number, g: number, b: number) =>
  (text: string): string =>
    `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;

/** 24-bit background. */
export const bg =
  (r: number, g: number, b: number) =>
  (text: string): string =>
    `\x1b[48;2;${r};${g};${b}m${text}${RESET}`;

const attr =
  (code: string) =>
  (text: string): string =>
    `\x1b[${code}m${text}${RESET}`;

export const bold = attr("1");
export const dim = attr("2");
export const italic = attr("3");
export const underline = attr("4");

export const palette = {
  text: fg(220, 215, 186),
  muted: fg(114, 113, 105),
  faint: fg(84, 84, 109),
  accent: fg(126, 156, 216),
  accentAlt: fg(149, 127, 184),
  ok: fg(152, 187, 108),
  warn: fg(230, 195, 132),
  err: fg(232, 36, 36),
  border: fg(84, 84, 109),
  borderFocus: fg(126, 156, 216),
} as const;

export interface FrameStyle {
  border: (text: string) => string;
  title: (text: string) => string;
}

export const frameStyle: FrameStyle = {
  border: palette.border,
  title: (text) => bold(palette.accent(text)),
};

export const focusedFrameStyle: FrameStyle = {
  border: palette.borderFocus,
  title: (text) => bold(palette.accent(text)),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => bold(palette.text(text)),
  link: (text) => underline(palette.accent(text)),
  linkUrl: (text) => dim(palette.faint(text)),
  code: (text) => palette.warn(text),
  codeBlock: (text) => palette.text(text),
  codeBlockBorder: (text) => palette.faint(text),
  quote: (text) => italic(palette.muted(text)),
  quoteBorder: (text) => palette.faint(text),
  hr: (text) => palette.faint(text),
  listBullet: (text) => palette.accent(text),
  bold: (text) => bold(palette.text(text)),
  italic: (text) => italic(palette.text(text)),
  strikethrough: (text) => attr("9")(palette.muted(text)),
  underline: (text) => underline(palette.text(text)),
};
