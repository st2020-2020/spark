// Calendar helpers for the journal-style inbox: day grouping, day stamps and greetings.
// All dates are shown in the viewer's local time zone.

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export interface DayStamp {
  key: string;
  /** Day of month, e.g. "19". */
  day: string;
  /** e.g. "11月" (with the year when it is not the current year). */
  month: string;
  /** e.g. "周三". */
  weekday: string;
  /** "今天" / "昨天" / "" — only for the two days people think of relatively. */
  relative: string;
  /** Full accessible label, e.g. "今天，11月19日 周三". */
  label: string;
}

export function dayStamp(iso: string, now = new Date()): DayStamp {
  const date = new Date(iso);
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  const relative = diffDays === 0 ? '今天' : diffDays === 1 ? '昨天' : '';
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月`;
  const weekday = WEEKDAYS[date.getDay()];
  const dateText = `${month}${date.getDate()}日 ${weekday}`;
  return {
    key: dayKey(date),
    day: String(date.getDate()),
    month,
    weekday,
    relative,
    label: relative ? `${relative}，${dateText}` : dateText,
  };
}

export interface DayGroup<T> {
  stamp: DayStamp;
  items: T[];
}

/** Groups items (already sorted newest first) into consecutive calendar days. */
export function groupByDay<T>(items: T[], getIso: (item: T) => string, now = new Date()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const stamp = dayStamp(getIso(item), now);
    const last = groups[groups.length - 1];
    if (last && last.stamp.key === stamp.key) {
      last.items.push(item);
    } else {
      groups.push({ stamp, items: [item] });
    }
  }
  return groups;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function todayLine(now = new Date()): string {
  return `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]}`;
}

/** True for items created within the last few seconds — used for the "just landed" glow. */
export function isJustCreated(iso: string, now = Date.now()): boolean {
  const created = new Date(iso).getTime();
  return now - created >= 0 && now - created < 8_000;
}
