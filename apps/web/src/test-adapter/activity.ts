import type { ActivityResult, ActivityQuery } from '../api/types';

// Test adapter only. Find the first instant whose local calendar label reaches the target,
// including zones that advanced their clocks at midnight or skipped a whole date.
export function mockActivity({ from, to, tz }: ActivityQuery, created: string[]): ActivityResult {
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone: tz });
  const counts = new Map<string, number>();
  for (const iso of created) {
    const date = format.format(new Date(iso));
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const dayMs = 86_400_000;
  function boundary(time: number) {
    const label = new Date(time).toISOString().slice(0, 10);
    let low = time - dayMs;
    let high = time + dayMs;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (format.format(middle) < label) low = middle + 1;
      else high = middle;
    }
    return new Date(high).toISOString();
  }
  const days: ActivityResult['days'] = [];
  const start = Date.parse(from);
  let fromInstant = boundary(start);
  for (let time = start; time < Date.parse(to); time += dayMs) {
    const date = new Date(time).toISOString().slice(0, 10);
    const toInstant = boundary(time + dayMs);
    days.push({ date, count: counts.get(date) ?? 0, created_from: fromInstant, created_to: toInstant });
    fromInstant = toInstant;
  }
  return { from, to, tz, days };
}
