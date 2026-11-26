import { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { POPOVER_EXIT_MS, usePresence } from '../lib/motion';
import { monthStart, useActivity, useLocalCalendar, validDate } from '../lib/revisit';
import { ErrorBanner } from './StateBlocks';

/**
 * The month heat map that filters the inbox by day. It lives next to the inbox it filters
 * (see ActivityCalendarButton) instead of taking a permanent row in the global navigation.
 */
export function ActivityCalendar({ onSelect }: { onSelect?: () => void }) {
  const { today, tz } = useLocalCalendar();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const rawSelected = pathname === '/inbox' ? params.get('date') : null;
  const selected = validDate(rawSelected) ? rawSelected : null;
  const anchor = selected ?? today;

  const [browsed, browse] = useState<{ anchor: string; month: string } | null>(null);
  const month = browsed?.anchor === anchor ? browsed.month : anchor.slice(0, 7);
  const activity = useActivity(month, tz);
  const first = new Date(monthStart(month) + 'T00:00:00Z');
  const leading = (first.getUTCDay() + 6) % 7;
  const monthLabel = `${first.getUTCFullYear()}年${first.getUTCMonth() + 1}月`;
  const [focusedDate, setFocusedDate] = useState('');
  const focusedDay = activity.data?.days.find(day => day.date === focusedDate);
  const monthTotal = activity.data?.days.reduce((sum, d) => sum + d.count, 0) ?? 0;

  useEffect(() => {
    browse(null);
    setFocusedDate('');
  }, [selected]);

  function changeMonth(offset: number) {
    browse({ anchor, month: monthStart(month, offset).slice(0, 7) });
    setFocusedDate('');
  }

  return (
    <section className="sp-calendar" aria-label="灵光日历">
      <div className="sp-calendar-head">
        <span className="sp-calendar-month-label" aria-live="polite">{monthLabel}</span>
        <div className="sp-calendar-switch">
          <button type="button" aria-label="上个月" onClick={() => changeMonth(-1)}><ChevronLeft size={15} /></button>
          <button type="button" aria-label="下个月" onClick={() => changeMonth(1)}><ChevronRight size={15} /></button>
        </div>
      </div>
      {activity.isPending && <p role="status" className="sp-help">正在加载日历…</p>}
      {activity.isError && <ErrorBanner error={activity.error} onRetry={() => void activity.refetch()} />}
      {activity.data && (
        <div className="sp-calendar-grid" onKeyDown={e => {
          const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
          if (!(e.key in steps) || !(e.target instanceof HTMLAnchorElement)) return;
          e.preventDefault();
          const links = Array.from(e.currentTarget.querySelectorAll('a'));
          links[links.indexOf(e.target) + steps[e.key]]?.focus();
        }}>
          {Array.from('一二三四五六日', d => <span key={d} aria-hidden="true">{d}</span>)}
          {Array.from({ length: leading }, (_, i) => <span key={i} aria-hidden="true" />)}
          {activity.data.days.map(({ date, count }) => {
            const day = Number(date.slice(8));
            const label = `${monthLabel}${day}日 · ${count} 条`;
            const isSelected = date === selected;
            const isToday = date === today;
            return (
              <Link
                key={date}
                to={isSelected ? '/inbox' : `/inbox?date=${date}`}
                aria-label={label}
                title={label}
                aria-current={isSelected ? 'date' : undefined}
                data-today={isToday ? 'true' : undefined}
                data-level={count >= 5 ? 3 : count >= 2 ? 2 : count > 0 ? 1 : 0}
                onPointerEnter={() => setFocusedDate(date)}
                onFocus={() => setFocusedDate(date)}
                onPointerDown={() => setFocusedDate(date)}
                onClick={onSelect}
              >
                {day}
              </Link>
            );
          })}
        </div>
      )}
      {activity.data && (
        <p className="sp-calendar-count">
          {focusedDay
            ? `${monthLabel}${Number(focusedDay.date.slice(8))}日 · ${focusedDay.count} 条`
            : `本月 ${monthTotal} 条`}
        </p>
      )}
    </section>
  );
}

/** Inbox header entry: a labelled button that drops the month view down beside the inbox. */
export function ActivityCalendarButton() {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = usePresence(open, POPOVER_EXIT_MS);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (panelRef.current) panelRef.current.inert = closing;
  }, [closing, mounted]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="sp-calendar-anchor" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="sp-btn sp-btn--sm sp-calendar-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Calendar size={15} strokeWidth={2} aria-hidden="true" />
        <span>灵光日历</span>
      </button>
      {mounted && (
        <div
          ref={panelRef}
          className={`sp-popover sp-popover--right sp-calendar-popover ${closing ? 'is-closing' : ''}`}
          role="dialog"
          aria-label="按日查看收件箱"
          aria-hidden={closing ? 'true' : undefined}
        >
          <ActivityCalendar onSelect={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
