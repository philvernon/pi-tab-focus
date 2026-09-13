import {
  getOsc8LinkAtColumn,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

const LITERAL_URL_PATTERN = /(?:https?:\/\/|file:\/\/|mailto:)[^\s<>()]+/gu;
const PARENTHESIZED_URL_PATTERN =
  /^\s+\(((?:https?:\/\/|file:\/\/|mailto:)[^\s<>()]+)\)/u;
const SGR_PATTERN = /\x1b\[([0-9:;]*)m/gu;
const OSC8_PATTERN = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/gu;

function literalUrlAtColumn(line: string, col: number): string | undefined {
  const stripped = stripTerminalSequences(line);
  for (const match of stripped.matchAll(LITERAL_URL_PATTERN)) {
    const text = match[0];
    const start = visibleWidth(stripped.slice(0, match.index));
    const end = start + visibleWidth(text);
    if (col >= start && col < end) return text;
  }
  return undefined;
}

function underlineRanges(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let underlined = false;
  let start = 0;

  for (const match of line.matchAll(SGR_PATTERN)) {
    const column = visibleWidth(stripTerminalSequences(line.slice(0, match.index)));
    const rawParams = match[1];
    const params = rawParams === "" ? ["0"] : rawParams.split(";");
    let next = underlined;

    for (const param of params) {
      if (param === "" || param === "0" || param === "24" || param === "4:0") {
        next = false;
      } else if (param === "4" || param.startsWith("4:")) {
        next = true;
      }
    }

    if (!underlined && next) start = column;
    if (underlined && !next && column > start) ranges.push({ start, end: column });
    underlined = next;
  }

  if (underlined) {
    const end = visibleWidth(stripTerminalSequences(line));
    if (end > start) ranges.push({ start, end });
  }

  return ranges;
}

function markdownFallbackUrlAtColumn(
  line: string,
  col: number,
): string | undefined {
  const range = underlineRanges(line).find(
    (candidate) => col >= candidate.start && col < candidate.end,
  );
  if (!range) return undefined;

  const stripped = stripTerminalSequences(line);
  const suffix = sliceByColumn(
    stripped,
    range.end,
    Math.max(0, visibleWidth(stripped) - range.end),
    true,
  );
  return PARENTHESIZED_URL_PATTERN.exec(suffix)?.[1];
}

export function transcriptLinkAtColumn(
  line: string,
  col: number,
): string | undefined {
  return (
    getOsc8LinkAtColumn(line, col) ??
    literalUrlAtColumn(line, col) ??
    markdownFallbackUrlAtColumn(line, col)
  );
}

export function firstTranscriptLink(lines: string[]): string | undefined {
  for (const line of lines) {
    const candidates: Array<{ col: number; url: string }> = [];
    const stripped = stripTerminalSequences(line);

    for (const match of line.matchAll(OSC8_PATTERN)) {
      const url = match[1];
      if (!url) continue;
      candidates.push({
        col: visibleWidth(stripTerminalSequences(line.slice(0, match.index))),
        url,
      });
      break;
    }

    for (const match of stripped.matchAll(LITERAL_URL_PATTERN)) {
      candidates.push({
        col: visibleWidth(stripped.slice(0, match.index)),
        url: match[0],
      });
      break;
    }

    const lineWidth = visibleWidth(stripped);
    for (const range of underlineRanges(line)) {
      const suffix = sliceByColumn(
        stripped,
        range.end,
        Math.max(0, lineWidth - range.end),
        true,
      );
      const url = PARENTHESIZED_URL_PATTERN.exec(suffix)?.[1];
      if (!url) continue;
      candidates.push({ col: range.start, url });
      break;
    }

    let first: { col: number; url: string } | undefined;
    for (const candidate of candidates) {
      if (!first || candidate.col < first.col) first = candidate;
    }
    if (first) return first.url;
  }

  return undefined;
}
