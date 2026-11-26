import { contentTypeLabels } from '../lib/format';
import { useMemo, useRef, useState } from 'react';
import { useFlipList, useSegmentIndicator } from '../lib/motion';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { CollectionType } from '../api/types';
import { CollectionCard } from '../components/CollectionCard';
import { Resurface } from '../components/Resurface';
import { useAuth } from '../context/AuthContext';
import { useActivity, useLocalCalendar, validDate } from '../lib/revisit';
import { CollectionComposer } from '../components/CollectionComposer';
import { PageHeader } from '../components/PageHeader';
import { PendingSuggestionsBanner } from '../components/PendingSuggestionsBanner';
import { EmptyState, ErrorBanner, LoadMore, LoadingState } from '../components/StateBlocks';
import { JarScene } from '../components/Illustrations';
import { ActivityCalendarButton } from '../components/ActivityCalendar';
import { useApi } from '../context/ApiContext';
import { useOrganizationEvents } from '../context/OrganizationEventsContext';
import { greeting, groupByDay, todayLine } from '../lib/journal';

export function InboxPage() {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showSecondaryFilter, setShowSecondaryFilter] = useState(
    Boolean(searchParams.get('type')),
  );

  const unreadOnly = searchParams.get('read') === 'false';
  const typeFilter = (searchParams.get('type') as CollectionType | null) ?? undefined;
  const shouldFocusComposer = searchParams.get('focus') === 'composer';

  const { user } = useAuth();
  const { pendingSuggestionsCount } = useOrganizationEvents();
  const { today, tz } = useLocalCalendar();
  const requestedDate = searchParams.get('date');
  const date = validDate(requestedDate) ? requestedDate : null;
  const dateLabel = date ? new Intl.DateTimeFormat('zh-CN', {
    year: date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
    month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(date + 'T00:00:00Z')) : '';
  const activity = useActivity((date ?? today).slice(0, 7), tz, !!date);
  const day = activity.data?.days.find(d => d.date === date);
  const hasInterval = !!day && Date.parse(day.created_from) < Date.parse(day.created_to);

  const collectionsQuery = useInfiniteQuery({
    queryKey: ['collections', 'inbox', user?.id, { unreadOnly, typeFilter, date, from: day?.created_from, to: day?.created_to }],
    enabled: !date || hasInterval,
    queryFn: ({ pageParam, signal }) =>
      api.listCollections(
        {
          scope: 'active',
          created_from: day?.created_from,
          created_to: day?.created_to,
          read: unreadOnly ? false : undefined,
          type: typeFilter,
          cursor: pageParam,
          limit: 30,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  });

  const items = collectionsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  // A dedicated triage pass only pays off once a few notes are waiting; for one or two,
  // the card itself is the quicker place to file them.
  const unclassifiedLoadedCount = useMemo(
    () =>
      items.filter(
        (c) =>
          !c.projects.some(
            (p) => p.decision === 'manual' || p.decision === 'confirmed' || p.decision === 'auto',
          ),
      ).length,
    [items],
  );
  const dayGroups = useMemo(() => groupByDay(items, (c) => c.created_at), [items]);
  const filtersActive = Boolean(unreadOnly || typeFilter || date);
  // Filters only help once there is something to filter; an empty inbox shows just the jar.
  const showFilterBar = filtersActive || items.length > 0;
  const journalRef = useRef<HTMLDivElement | null>(null);
  const filterTabsRef = useRef<HTMLDivElement | null>(null);
  useFlipList(journalRef, items.map((c) => c.id).join('|'));
  useSegmentIndicator(filterTabsRef, `${unreadOnly}:${showFilterBar}`);
  const headerLine = `${greeting()}，${todayLine()}`;

  const updateFilter = (next: { unreadOnly?: boolean; type?: CollectionType | ''; clearDate?: boolean }) => {
    const params = new URLSearchParams(searchParams);
    params.delete('focus');
    if (next.clearDate) params.delete('date');
    if (next.unreadOnly !== undefined) {
      if (next.unreadOnly) params.set('read', 'false');
      else params.delete('read');
    }
    if (next.type !== undefined) {
      if (next.type) params.set('type', next.type);
      else params.delete('type');
    }
    setSearchParams(params, { replace: true });
  };

  return (
    <div>
      <PageHeader title="收件箱" subtitle={headerLine}
        badge={date && <button type="button" className="sp-btn sp-btn--sm" aria-label={`清除日期筛选，${dateLabel}`}
          onClick={() => updateFilter({ clearDate: true })}>
          {dateLabel} ×
        </button>}
        actions={<ActivityCalendarButton />} />

      <CollectionComposer autoFocus={shouldFocusComposer} />

      {!date && <Resurface key={user?.id} />}
      <PendingSuggestionsBanner />

      {showFilterBar && (
      <div className="sp-filter-bar">
        <div className="sp-filter-tabs" aria-label="收件箱筛选" ref={filterTabsRef}>
          <button
            type="button"
            className={`sp-filter-tab ${!unreadOnly ? 'active' : ''}`}
            aria-pressed={!unreadOnly}
            onClick={() => updateFilter({ unreadOnly: false })}
          >
            全部
          </button>
          <button
            type="button"
            className={`sp-filter-tab ${unreadOnly ? 'active' : ''}`}
            aria-pressed={unreadOnly}
            onClick={() => updateFilter({ unreadOnly: true })}
          >
            未读
          </button>
        </div>
        <button
          type="button"
          className="sp-btn--quiet sp-btn--icon sp-note-footer-action"
          aria-label="展开类型筛选"
          aria-expanded={showSecondaryFilter}
          onClick={() => setShowSecondaryFilter((v) => !v)}
        >
          <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      )}

      {showFilterBar && showSecondaryFilter && (
        <div className="sp-filter-panel">
          <label htmlFor="inbox-type-filter" className="sp-filter-panel-label">
            内容类型
          </label>
          <select
            id="inbox-type-filter"
            className="sp-select sp-select--compact"
            value={typeFilter ?? ''}
            onChange={(e) => updateFilter({ type: e.target.value as CollectionType | '' })}
          >
            <option value="">全部</option>
            {Object.entries(contentTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          {typeFilter && (
            <button
              type="button"
              className="sp-btn--quiet sp-btn--sm"
              onClick={() => updateFilter({ type: '' })}
            >
              清除
            </button>
          )}
        </div>
      )}

      {!collectionsQuery.isLoading &&
        !collectionsQuery.isError &&
        unclassifiedLoadedCount >= 3 &&
        pendingSuggestionsCount === 0 && (
        <div className="sp-triage-hint-bar">
          <Link to="/unclassified/triage" className="sp-triage-hint">
            <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
            <span>{unclassifiedLoadedCount} 条还没归入项目，一次整理完</span>
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      )}

      {date && activity.isError && <ErrorBanner error={activity.error} onRetry={() => void activity.refetch()} />}
      {(collectionsQuery.isLoading || (!!date && activity.isPending)) && <LoadingState message="正在加载收件箱…" />}
      {collectionsQuery.isError && (
        <ErrorBanner
          error={collectionsQuery.error}
          onRetry={() => void collectionsQuery.refetch()}
        />
      )}
      {!collectionsQuery.isLoading &&
        !collectionsQuery.isError &&
        (!date || activity.isSuccess) && items.length === 0 &&
        (date || unreadOnly || typeFilter ? (
          <EmptyState
            title={date ? '这一天没有符合条件的收藏' : '当前筛选下没有收藏'}
            description="可以切换回全部，或先在上方记下新的内容。"
            action={
              <button
                type="button"
                className="sp-btn"
                onClick={() => updateFilter({ unreadOnly: false, type: '', clearDate: true })}
              >
                清除筛选
              </button>
            }
          />
        ) : (
          <div className="sp-inbox-empty">
            <JarScene className="sp-inbox-empty-art" />
            <p className="sp-inbox-empty-title">保存的内容会出现在这里。</p>
            <p className="sp-inbox-empty-hint">先记下来，项目可以稍后再选。</p>
          </div>
        ))}

      <div className="sp-journal" ref={journalRef}>
        {dayGroups.map((group) => (
          <section key={group.stamp.key} className="sp-day">
            <h2
              data-flip-key={`day:${group.stamp.key}`}
              data-flip-measure="parent"
              className={`sp-day-stamp ${date || group.stamp.relative === '今天' ? 'sp-day-stamp--today' : ''}`}
              aria-label={group.stamp.label}
            >
              <span className="sp-day-top" aria-hidden="true">
                {group.stamp.relative || group.stamp.month}
              </span>
              <span className="sp-day-num" aria-hidden="true">
                {group.stamp.day}
              </span>
              <span className="sp-day-week" aria-hidden="true">
                {group.stamp.weekday}
              </span>
            </h2>
            <div className="sp-note-list">
              {group.items.map((col) => (
                <CollectionCard key={col.id} collection={col} timeStyle="clock" />
              ))}
            </div>
          </section>
        ))}
      </div>

      <LoadMore
        hasNextPage={collectionsQuery.hasNextPage}
        isFetching={collectionsQuery.isFetchingNextPage}
        isError={collectionsQuery.isFetchNextPageError}
        onLoad={() => void collectionsQuery.fetchNextPage()}
      />
    </div>
  );
}
