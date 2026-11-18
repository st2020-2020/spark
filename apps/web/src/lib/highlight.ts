export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function parseSearchTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).filter(Boolean).slice(0, 10);
}

export function splitHighlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = parseSearchTerms(query);
  if (!text || terms.length === 0) {
    return [{ text, match: false }];
  }

  const lowerText = text.toLowerCase();
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const ranges: Array<[number, number]> = [];

  for (const term of lowerTerms) {
    if (!term) continue;
    let start = 0;
    while (start < lowerText.length) {
      const idx = lowerText.indexOf(term, start);
      if (idx === -1) break;
      ranges.push([idx, idx + term.length]);
      start = idx + term.length;
    }
  }

  if (ranges.length === 0) {
    return [{ text, match: false }];
  }

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (!last || s > last[1]) {
      merged.push([s, e]);
    } else if (e > last[1]) {
      last[1] = e;
    }
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) {
      segments.push({ text: text.slice(cursor, s), match: false });
    }
    segments.push({ text: text.slice(s, e), match: true });
    cursor = e;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
}
