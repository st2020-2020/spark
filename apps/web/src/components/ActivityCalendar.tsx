import { useEffect, useState } from 'react';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { monthStart, useActivity, useLocalCalendar, validDate } from '../lib/revisit';
import { ErrorBanner } from './StateBlocks';

export function ActivityCalendar({ onSelect }: { onSelect?: () => void }) {
  const { today, tz } = useLocalCalendar();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const rawSelected = pathname === '/inbox' ? params.get('date') : null;
  const selected = validDate(rawSelected) ? rawSelected : null;
  const anchor = selected ?? today;

  const [expanded, setExpanded] = useState(() => Boolean(selected));
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
    if (selected) {
      setExpanded(true);
    }
  }, [selected]);

  function changeMonth(offset: number) {
    browse({ anchor, month: monthStart(month, offset).slice(0, 7) });
    setFocusedDate('');
  }

  const selectedShort = selected ? `${Number(selected.slice(5, 7))}/${Number(selected.slice(8))}` : '';
  const summarySuffix = activity.data ? ` · 本月 ${monthTotal} 条` : '';

  return (
    <section
      className={`sp-calendar ${selected ? 'sp-calendar--date-active' : ''} ${expanded ? 'is-expanded' : ''}`}
      aria-label="灵光日历"
    >
      <div className="sp-calendar-trigger-row">
        <button
          type="button"
          className="sp-calendar-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <Calendar size={14} strokeWidth={2} aria-hidden="true" />
          <span className="sp-calendar-toggle-text sp-truncate">
            灵光日历{summarySuffix}
          </span>
          {selected && !expanded && (
            <span className="sp-calendar-selected-pill">{selectedShort}</span>
          )}
          <ChevronDown
            size={14}
            strokeWidth={2}
            className="sp-calendar-chevron"
            aria-hidden="true"
          />
        </button>

        {selected && (
          <Link
            to="/inbox"
            className="sp-calendar-clear"
            aria-label="清除日历日期筛选"
            title="回到全部日期"
            onClick={onSelect}
          >
            <X size={13} strokeWidth={2.2} aria-hidden="true" />
          </Link>
        )}
      </div>

      <div className={`sp-calendar-collapse ${expanded ? 'is-open' : ''}`}>
        <div className="sp-calendar-collapse-inner">
          {expanded && (
            <div className="sp-calendar-body">
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
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
