import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { monthStart, useLocalCalendar, validDate } from '../lib/revisit';

// Calendar labels are plain dates; UTC keeps the arithmetic free of local DST shifts.
// The API turns each date into the real local-day interval.
const DAY_MS = 86_400_000;
const WEEKS = 12;
const STRIP_DAYS = 14;
const WEEKDAYS = '日一二三四五六';

function addDays(date: string, offset: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + offset * DAY_MS).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function mondayOf(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

function heatLevel(count: number): 0 | 1 | 2 | 3 {
  return count >= 5 ? 3 : count >= 2 ? 2 : count > 0 ? 1 : 0;
}

function shortLabel(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
}

function dayLabel(date: string, count: number): string {
  return `${shortLabel(date)} 周${WEEKDAYS[weekday(date)]} · ${count} 条`;
}

/** Months (YYYY-MM) touched by the window; the activity API reads at most one month per call. */
function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  for (let m = first.slice(0, 7); m <= last.slice(0, 7); m = monthStart(m, 1).slice(0, 7)) months.push(m);
  return months;
}

function useSelectedDate(): string | null {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const raw = pathname === '/inbox' ? params.get('date') : null;
  return validDate(raw) ? raw : null;
}

/** Daily counts for a window, one request per month, shared with the inbox's day lookup. */
function useDayCounts(firstDay: string, lastDay: string, tz: string) {
  const api = useApi();
  const { user } = useAuth();
  const results = useQueries({
    queries: monthsBetween(firstDay, lastDay).map((month) => ({
      // Same key as useActivity.
      queryKey: ['collections', 'activity', user?.id, month, tz],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.getActivity({ from: monthStart(month), to: monthStart(month, 1), tz }, signal),
      enabled: Boolean(user),
      staleTime: 60_000,
    })),
  });
  const counts = new Map<string, number>();
  for (const result of results) for (const day of result.data?.days ?? []) counts.set(day.date, day.count);
  return {
    counts,
    loaded: results.every((r) => r.isSuccess),
    failed: results.some((r) => r.isError),
    retry: () => results.forEach((r) => r.isError && void r.refetch()),
  };
}

/**
 * One tab stop for a row or grid of day links: the selected day, else today, else the last day.
 * Arrow keys move focus by the given steps, staying inside the visible days.
 */
function useRovingDays(days: string[], preferred: string, steps: Record<string, number>) {
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const tabStop = focusDate && days.includes(focusDate) ? focusDate : preferred;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingFocus.current) return;
    containerRef.current?.querySelector<HTMLAnchorElement>(`a[data-day="${pendingFocus.current}"]`)?.focus();
    pendingFocus.current = null;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.key in steps) || !(event.target instanceof HTMLAnchorElement)) return;
    const from = event.target.dataset.day;
    if (!from) return;
    const next = addDays(from, steps[event.key]);
    if (!days.includes(next)) return;
    event.preventDefault();
    setFocusDate(next);
    pendingFocus.current = next;
  };

  return { tabStop, containerRef, onKeyDown, setFocusDate };
}

function DayCell({ date, count, loaded, selected, today, tabStop, onFocus, onNavigate }: {
  date: string;
  count: number;
  loaded: boolean;
  selected: string | null;
  today: string;
  tabStop: string;
  onFocus: (date: string) => void;
  onNavigate?: () => void;
}) {
  const isSelected = date === selected;
  const label = dayLabel(date, count);
  return (
    <Link
      data-day={date}
      to={isSelected ? '/inbox' : `/inbox?date=${date}`}
      className="sp-heatmap-cell"
      data-level={loaded ? heatLevel(count) : undefined}
      data-today={date === today ? 'true' : undefined}
      aria-current={isSelected ? 'date' : undefined}
      aria-label={label}
      title={label}
      tabIndex={date === tabStop ? 0 : -1}
      onFocus={() => onFocus(date)}
      onClick={onNavigate}
    />
  );
}

/**
 * 灵光日历 in the sidebar: one row showing the last two weeks, always visible. The row's
 * header opens the full twelve-week heat grid as a popover. Any day filters the inbox.
 */
export function ActivityCalendar({ onNavigate }: { onNavigate?: () => void }) {
  const { today, tz } = useLocalCalendar();
  const selected = useSelectedDate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();

  // The header's streak reads the same twelve weeks the popover opens on, so both agree.
  const windowStart = addDays(mondayOf(today), -(WEEKS - 1) * 7);
  const { counts, loaded, failed, retry } = useDayCounts(windowStart, today, tz);
  const days = Array.from({ length: STRIP_DAYS }, (_, i) => addDays(today, i - STRIP_DAYS + 1));
  const recentTotal = days.reduce((sum, date) => sum + (counts.get(date) ?? 0), 0);
  // A streak still counts if today has nothing yet: it runs back from yesterday then.
  let streak = 0;
  let cursor = (counts.get(today) ?? 0) > 0 ? today : addDays(today, -1);
  while (cursor >= windowStart && (counts.get(cursor) ?? 0) > 0) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  const summary = !loaded ? '' : streak > 0
    ? `连续 ${streak}${cursor < windowStart ? '+' : ''} 天`
    : `近两周 ${recentTotal} 条`;

  const preferred = selected && days.includes(selected) ? selected : today;
  const roving = useRovingDays(days, preferred, { ArrowLeft: -1, ArrowRight: 1 });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      // Stop here so an enclosing drawer stays open; only the popover closes.
      event.stopPropagation();
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = () => {
    setOpen(false);
    onNavigate?.();
  };

  return (
    <section
      ref={wrapRef}
      className="sp-activity"
      aria-label="灵光日历"
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        className="sp-activity-head"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sp-activity-title">灵光日历</span>
        <span className="sp-activity-summary">{summary}</span>
        <ChevronDown size={13} strokeWidth={2.2} className="sp-activity-chevron" aria-hidden="true" />
      </button>

      {failed ? (
        <p className="sp-heatmap-error" role="alert">
          日历没有加载出来。
          <button type="button" onClick={retry}>重试</button>
        </p>
      ) : (
        <div
          ref={roving.containerRef}
          className="sp-activity-strip"
          onKeyDown={roving.onKeyDown}
          aria-busy={!loaded || undefined}
        >
          {days.map((date) => (
            <DayCell
              key={date}
              date={date}
              count={counts.get(date) ?? 0}
              loaded={loaded}
              selected={selected}
              today={today}
              tabStop={roving.tabStop}
              onFocus={roving.setFocusDate}
              onNavigate={pick}
            />
          ))}
        </div>
      )}

      {open && (
        <div id={popoverId} className="sp-activity-popover" role="dialog" aria-label="灵光日历详情">
          <ActivityHeatmap today={today} tz={tz} selected={selected} onNavigate={pick} />
        </div>
      )}
    </section>
  );
}

/** Twelve weeks as a heat grid (columns are weeks, Monday on top) with totals and paging. */
function ActivityHeatmap({ today, tz, selected, onNavigate }: {
  today: string;
  tz: string;
  selected: string | null;
  onNavigate: () => void;
}) {
  // pageOffset counts 12-week pages back from the current one; it opens on the selected day.
  const thisMonday = mondayOf(today);
  const pageOf = (date: string | null) => {
    if (!date || date > today) return 0;
    const weeksBack = Math.round((Date.parse(thisMonday) - Date.parse(mondayOf(date))) / (7 * DAY_MS));
    return Math.floor(weeksBack / WEEKS);
  };
  const [pageOffset, setPageOffset] = useState(() => pageOf(selected));
  const lastMonday = addDays(thisMonday, -pageOffset * WEEKS * 7);
  const firstDay = addDays(lastMonday, -(WEEKS - 1) * 7);
  const lastDay = addDays(lastMonday, 6) > today ? today : addDays(lastMonday, 6);
  const { counts, loaded, failed, retry } = useDayCounts(firstDay, lastDay, tz);

  const columns = Array.from({ length: WEEKS }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(firstDay, w * 7 + d)),
  );
  const visibleDays = columns.flat().filter((date) => date <= today);
  const total = visibleDays.reduce((sum, date) => sum + (counts.get(date) ?? 0), 0);
  const activeDays = visibleDays.filter((date) => (counts.get(date) ?? 0) > 0).length;

  const preferred = selected && visibleDays.includes(selected)
    ? selected
    : visibleDays.includes(today) ? today : visibleDays[visibleDays.length - 1];
  const roving = useRovingDays(visibleDays, preferred, { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 });

  // Opening moves focus onto the grid's tab stop so arrow keys work right away; only on mount,
  // later focus follows the user's own moves.
  const gridRef = roving.containerRef;
  useEffect(() => {
    gridRef.current?.querySelector<HTMLAnchorElement>('a[tabindex="0"]')?.focus();
  }, [gridRef]);

  const monthLabels = columns.map((week, i) => {
    const firstOfMonth = week.find((date) => date.endsWith('-01'));
    if (firstOfMonth) return `${Number(firstOfMonth.slice(5, 7))}月`;
    return i === 0 ? `${Number(week[0].slice(5, 7))}月` : '';
  });
  // Drop a leading label that would collide with the next month's label right after it.
  if (monthLabels[0] && monthLabels[1]) monthLabels[0] = '';

  const rangeLabel = pageOffset === 0 ? '近 12 周' : `${shortLabel(firstDay)}–${shortLabel(lastDay)}`;
  const page = (delta: number) => {
    setPageOffset((p) => Math.max(0, p + delta));
    roving.setFocusDate(null);
  };

  return (
    <div className="sp-heatmap">
      <dl className="sp-heatmap-stats">
        <div>
          <dt>{rangeLabel}</dt>
          <dd>{loaded ? total : '–'}<span> 条</span></dd>
        </div>
        <div>
          <dt>记录天数</dt>
          <dd>{loaded ? activeDays : '–'}<span> 天</span></dd>
        </div>
      </dl>

      {failed ? (
        <p className="sp-heatmap-error" role="alert">
          日历没有加载出来。
          <button type="button" onClick={retry}>重试</button>
        </p>
      ) : (
        <div
          ref={roving.containerRef}
          className="sp-heatmap-grid"
          onKeyDown={roving.onKeyDown}
          aria-busy={!loaded || undefined}
        >
          {columns.flat().map((date) =>
            date > today ? (
              <span key={date} className="sp-heatmap-cell is-future" aria-hidden="true" />
            ) : (
              <DayCell
                key={date}
                date={date}
                count={counts.get(date) ?? 0}
                loaded={loaded}
                selected={selected}
                today={today}
                tabStop={roving.tabStop}
                onFocus={roving.setFocusDate}
                onNavigate={onNavigate}
              />
            ),
          )}
        </div>
      )}

      <div className="sp-heatmap-foot">
        <div className="sp-heatmap-months" aria-hidden="true">
          {monthLabels.map((label, i) => <span key={i}>{label}</span>)}
        </div>
        <div className="sp-heatmap-paging">
          <button type="button" aria-label="更早的 12 周" title="更早" onClick={() => page(1)}>
            <ChevronLeft size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="更近的 12 周"
            title="更近"
            disabled={pageOffset === 0}
            onClick={() => page(-1)}
          >
            <ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
