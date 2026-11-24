import { useEffect, useLayoutEffect, useState, useRef, useMemo } from 'react';
import {
  Archive,
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Inbox,
  NotebookPen,
  PanelLeft,
  RefreshCw,
  Search,
  Settings2,
  Check,
  Laptop,
  Moon,
  Sun,
  X,
} from 'lucide-react';
import {
  active,
  formatShortcut,
  message,
  phase,
  type Choice,
  type Outbox,
  type Request,
  type State,
  type Summary,
} from './bridge';
import { ImageView, Jar, Notice, Login, Preview, Tool } from './shared';
import { JarScene } from '../../../web/src/components/Illustrations';
import { greeting, todayLine, groupByDay } from '../../../web/src/lib/journal';
import { PALETTES } from '../../../web/src/lib/appearance';
import { projectToneClass } from '../../../web/src/lib/projectTone';
import { Capture } from './Panel';
import { SidebarGroup, sidebarScope } from './SidebarSpace';
import { extractDomain } from '../../../web/src/lib/format';
import { SearchResults, useSearch } from './Search';
function EntryCard({
  entry,
  req,
  onOpen,
}: {
  entry: Summary;
  req: Request;
  onOpen: () => void;
}) {
  const projects =
    entry.projects?.filter((p) => p.name && active(p.decision)) ?? [];
  const tags = entry.tags?.filter((t) => t.path && active(t.decision)) ?? [];
  const extraProjects = projects
    .slice(2)
    .map((p) => p.name)
    .join('、');
  const extraTags = tags
    .slice(3)
    .map((t) => '#' + t.path)
    .join('、');
  const domain = extractDomain(entry.original_url);
  return (
    <button className="card" onClick={onOpen}>
      <strong>{entry.display_title}</strong>
      {entry.excerpt?.trim() && <p>{entry.excerpt}</p>}
      {entry.cover_attachment_id && (
        <ImageView req={req} id={entry.cover_attachment_id} name="收藏缩略图" />
      )}
      {(domain || projects.length > 0 || tags.length > 0) && (
        <span className="entry-meta">
          {projects.slice(0, 2).map((p) => (
            <span
              key={p.project_id}
              className={'entry-project ' + projectToneClass(p.project_id)}
              title={p.name}
            >
              <i aria-hidden="true" />
              <span>{p.name}</span>
            </span>
          ))}
          {projects.length > 2 && (
            <small
              className="meta-more"
              role="img"
              aria-label={
                '另有 ' + (projects.length - 2) + ' 个项目：' + extraProjects
              }
              title={extraProjects}
            >
              +{projects.length - 2}
            </small>
          )}
          {tags.slice(0, 3).map((t) => (
            <small className="entry-tag" key={t.tag_id} title={t.path}>
              #{t.path}
            </small>
          ))}
          {tags.length > 3 && (
            <small
              className="meta-more"
              role="img"
              aria-label={'另有 ' + (tags.length - 3) + ' 个标签：' + extraTags}
              title={extraTags}
            >
              +{tags.length - 3}
            </small>
          )}
          {domain && (
            <small className="entry-domain" title={domain}>
              {domain}
            </small>
          )}
        </span>
      )}
    </button>
  );
}
function SyncTool({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const [turning, setTurning] = useState(false);
  return (
    <Tool label="立即同步" aria-busy={busy} disabled={busy} onClick={onClick}>
      <RefreshCw
        className={busy || turning ? 'spinning' : undefined}
        onAnimationStart={() => setTurning(true)}
        onAnimationIteration={() => {
          if (!busy) setTurning(false);
        }}
      />
    </Tool>
  );
}
type Props = { state: State; req: Request; refresh: () => void };
export function Book(props: Props) {
  const scope = sidebarScope(
    props.state.origin,
    props.state.session.account_id,
  );
  return (
    <Journal
      key={scope ?? props.state.session.account_id}
      {...props}
      scope={scope}
    />
  );
}
function Journal({
  state,
  req,
  refresh,
  scope,
}: Props & { scope: string | null }) {
  const [tab, tabTo] = useState('inbox'),
    [detail, open] = useState(
      new URLSearchParams(location.search).get('id') || '',
    ),
    [fold, collapse] = useState(false),
    [width, size] = useState(240);
  const [entries, cards] = useState<Summary[]>([]),
    [outbox, pending] = useState<Outbox[]>([]),
    [projects, projectList] = useState<Choice[]>([]),
    [tags, tagList] = useState<Choice[]>([]);
  const [q, type] = useState(''),
    [query, commit] = useState(''),
    [busy, loading] = useState(false),
    [err, bad] = useState(''),
    [offline, off] = useState(false),
    [cursor, next] = useState(''),
    [rev, update] = useState(0),
    [confirm, ask] = useState(''),
    [syncing, setSyncing] = useState(false),
    [working, work] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [pinDialog, setPinDialog] = useState<'projects' | 'tags' | null>(null);
  const [focusRequest, requestFocus] = useState(0);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = setInterval(tick, 60000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, []);
  const dayGroups = useMemo(
    () => groupByDay(entries, (entry) => entry.created_at, now),
    [entries, now],
  );
  const input = useRef<HTMLInputElement>(null),
    ime = useRef(false),
    serial = useRef(0),
    {
      hits,
      error,
      offline: searchOffline,
    } = useSearch(req, query, !!query, !!state.session.expired);
  const pid = tab.startsWith('p:') ? tab.slice(2) : '',
    tid = tab.startsWith('t:') ? tab.slice(2) : '';
  const title =
    {
      inbox: '收件箱',
      all: '全部收藏',
      outbox: '本机发件箱',
      settings: '设备与外观',
    }[tab] ||
    [...projects, ...tags].find((x) => x.id === (pid || tid))?.name ||
    '收藏';
  // Older sessions may serialize a missing expiry as Go’s zero time.
  const expiresAt = Date.parse(state.session.expires_at ?? '');
  const count =
    (state.counts.local_saved ?? 0) +
    (state.counts.syncing ?? 0) +
    (state.counts.auth_paused ?? 0) +
    (state.counts.needs_review ?? 0);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (confirm) dialog.current?.showModal();
  }, [confirm]);
  const confirmTrigger = useRef<HTMLButtonElement>(null);
  function requestConfirmation(action: string, trigger: HTMLButtonElement) {
    bad('');
    confirmTrigger.current = trigger;
    ask(action);
  }
  function cancelConfirmation() {
    dialog.current?.close();
    ask('');
    confirmTrigger.current?.focus();
  }
  function nav(t: string) {
    ask('');
    tabTo(t);
    open('');
    type('');
    commit('');
    bad('');
  }
  function compose() {
    setPinDialog(null);
    nav('inbox');
    requestFocus((v) => v + 1);
  }
  useEffect(() => {
    if (!focusRequest) return;
    editor.current?.focus({ preventScroll: true });
    editor.current?.scrollIntoView({
      block: 'nearest',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  }, [focusRequest]);
  useEffect(() => {
    const change = () => update((r) => r + 1),
      select = (e: Event) => open((e as CustomEvent).detail);
    const key = (e: KeyboardEvent) => {
      if (
        document.querySelector('dialog[open]') ||
        !e.metaKey ||
        e.isComposing ||
        e.keyCode === 229
      )
        return;
      if (e.key === '\\') {
        e.preventDefault();
        collapse((v) => !v);
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        compose();
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('spark-state', change);
    window.addEventListener('spark-detail', select);
    window.addEventListener('spark-compose', compose);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('spark-state', change);
      window.removeEventListener('spark-detail', select);
      window.removeEventListener('spark-compose', compose);
      window.removeEventListener('keydown', key);
    };
  }, []);
  useEffect(() => {
    const c = new AbortController();
    Promise.all([
      req<Outbox[]>('outbox', 'GET', undefined, c.signal),
      req<Choice[]>('projects', 'GET', undefined, c.signal),
      req<Choice[]>('tags', 'GET', undefined, c.signal),
    ])
      .then(([items, p, t]) => {
        if (c.signal.aborted) return;
        pending(items);
        projectList(p);
        tagList(t);
      })
      .catch((e) => {
        if (!c.signal.aborted) bad(message(e));
      });
    return () => c.abort();
  }, [req, rev]);
  useEffect(() => {
    const c = new AbortController(),
      seq = ++serial.current;
    loading(true);
    bad('');
    next('');
    cards([]);
    async function load() {
      const cached = await req<Summary[]>(
        'collections?project_id=' + pid,
        'GET',
        undefined,
        c.signal,
      );
      if (seq !== serial.current) return;
      cards(
        tid
          ? cached.filter((s) =>
              s.tags?.some((t) => t.tag_id === tid && active(t.decision)),
            )
          : cached,
      );
      if (state.session.expired) return;
      const page = await req<{ items: Summary[]; next_cursor?: string }>(
        'collections/page?project_id=' + pid + '&tag_id=' + tid,
        'GET',
        undefined,
        c.signal,
      );
      if (seq === serial.current) {
        cards(page.items || []);
        next(page.next_cursor || '');
        off(false);
      }
    }
    load()
      .catch(() => {
        if (!c.signal.aborted) off(true);
      })
      .finally(() => {
        if (!c.signal.aborted) loading(false);
      });
    return () => {
      c.abort();
      serial.current++;
    };
  }, [req, pid, tid, rev, state.session.expired]);
  async function more() {
    const seq = serial.current;
    loading(true);
    try {
      const page = await req<{ items: Summary[]; next_cursor?: string }>(
        'collections/page?project_id=' +
          pid +
          '&tag_id=' +
          tid +
          '&cursor=' +
          encodeURIComponent(cursor),
      );
      if (seq === serial.current) {
        cards((xs) => [
          ...xs,
          ...page.items.filter((y) => !xs.some((x) => x.id === y.id)),
        ]);
        next(page.next_cursor || '');
      }
    } catch (e) {
      bad(message(e));
    } finally {
      if (seq === serial.current) loading(false);
    }
  }
  async function sync() {
    setSyncing(true);
    bad('');
    try {
      await req('sync/now', 'POST');
      off(false);
      update((v) => v + 1);
    } catch (e) {
      bad(message(e));
      off(true);
    } finally {
      setSyncing(false);
    }
  }
  useEffect(() => {
    if (!state.session.expired) void sync();
  }, [req, state.session.expired]);
  function clear() {
    type('');
    commit('');
    input.current?.focus();
  }
  async function confirmed() {
    work(true);
    try {
      if (confirm === 'disconnect') {
        await req('session/disconnect', 'POST');
        refresh();
      } else {
        await req('outbox/' + confirm, 'DELETE');
        open('');
        update((v) => v + 1);
      }
      ask('');
    } catch (e) {
      bad(message(e));
    } finally {
      work(false);
    }
  }
  const visiblePending = outbox.filter(
    (o) =>
      (!pid || o.project_ids.includes(pid)) &&
      (!tid || o.tag_ids.includes(tid)),
  );
  const [appearanceBusy, setAppearanceBusy] = useState(false);
  async function changeAppearance(palette: string, mode: string) {
    setAppearanceBusy(true);
    try {
      await req('prefs', 'PUT', { palette, mode });
      refresh();
    } catch (e) {
      bad(message(e));
    } finally {
      setAppearanceBusy(false);
    }
  }
  const waiting = (state.counts.local_saved || 0) + (state.counts.syncing || 0);
  const status = state.session.expired
    ? '会话已到期'
    : state.counts.needs_review
      ? `${state.counts.needs_review} 条需核对`
      : offline
        ? '离线模式'
        : waiting
          ? `${waiting} 条待同步`
          : '';
  return (
    <div className="book">
      <div className="workspace">
        {!fold && (
          <aside style={{ width }}>
            <div className="sidebar-fixed">
              <div className="sidebar-top">
                <div className="brand">
                  <Jar />
                  Spark
                </div>
                <Tool label="折叠侧栏" onClick={() => collapse(true)}>
                  <PanelLeft />
                </Tool>
              </div>
              <div className="sidebar-actions">
                <button
                  className="primary compose"
                  title={`在收件箱写随手记 ⌘N · 随手记快捷键 ${formatShortcut(state.capture_key)}`}
                  onClick={compose}
                >
                  <NotebookPen />
                  随手记{' '}
                  <kbd aria-hidden={width <= 230 || undefined}>
                    {formatShortcut(state.capture_key)}
                  </kbd>
                </button>
                <button
                  className="sidebar-search"
                  aria-label="快搜 ⌘K"
                  title="搜索手帐 ⌘K"
                  onClick={() => input.current?.focus()}
                >
                  <Search />
                  <kbd>⌘K</kbd>
                </button>
              </div>
              <nav className="core-nav" aria-label="手帐导航">
                {[
                  ['inbox', Inbox, '收件箱'],
                  ['all', BookOpen, '全部收藏'],
                  ['outbox', Archive, '本机发件箱'],
                ].map(([value, Icon, label]) => {
                  const I = Icon as typeof Inbox;
                  return (
                    <button
                      key={String(value)}
                      aria-current={tab === value ? 'page' : undefined}
                      className={tab === value ? 'chosen' : ''}
                      onClick={() => nav(String(value))}
                    >
                      <I />
                      {String(label)}
                      {value === 'outbox' && count > 0 && (
                        <small>{count}</small>
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>
            <nav className="sidebar-space" aria-label="我的空间">
              <SidebarGroup
                kind="projects"
                customizing={pinDialog === 'projects'}
                customize={(open) => setPinDialog(open ? 'projects' : null)}
                scope={scope}
                choices={projects}
                selected={pid}
                onNavigate={(id) => nav('p:' + id)}
              />
              <SidebarGroup
                kind="tags"
                customizing={pinDialog === 'tags'}
                customize={(open) => setPinDialog(open ? 'tags' : null)}
                scope={scope}
                choices={tags}
                selected={tid}
                onNavigate={(id) => nav('t:' + id)}
              />
            </nav>
            <button
              className="account"
              title={state.session.account_label + ' · 设备与外观'}
              onClick={() => nav('settings')}
            >
              <span className="avatar" aria-hidden="true">
                {state.session.account_label?.slice(0, 1).toUpperCase()}
              </span>
              <span className="account-text">
                <strong>{state.session.account_label}</strong>
                <small>设备与外观</small>
              </span>
              <Settings2 />
            </button>
            <div
              role="separator"
              aria-label="调整侧栏宽度"
              aria-orientation="vertical"
              tabIndex={0}
              aria-valuemin={200}
              aria-valuemax={300}
              aria-valuenow={width}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  size(
                    Math.max(
                      200,
                      Math.min(
                        300,
                        width + (e.key === 'ArrowRight' ? 10 : -10),
                      ),
                    ),
                  );
                }
              }}
              className="grip"
              onPointerDown={(e) =>
                e.currentTarget.setPointerCapture(e.pointerId)
              }
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  size(Math.max(200, Math.min(300, e.clientX)));
              }}
            />
          </aside>
        )}
        <div className="journal-pane" data-folded={fold}>
          <header className="titlebar">
            {fold && (
              <Tool label="展开侧栏" onClick={() => collapse(false)}>
                <PanelLeft />
              </Tool>
            )}
            <span>{title}</span>
            <div className="searchbox">
              <Search />
              <input
                ref={input}
                value={q}
                placeholder="搜索手帐"
                aria-label="搜索手帐"
                onKeyDown={(e) => {
                  if (
                    e.key !== 'Escape' ||
                    ime.current ||
                    e.nativeEvent.isComposing ||
                    e.keyCode === 229
                  )
                    return;
                  e.preventDefault();
                  open('');
                  if (q) clear();
                  else e.currentTarget.blur();
                }}
                onCompositionStart={() => (ime.current = true)}
                onCompositionEnd={(e) => {
                  ime.current = false;
                  commit(e.currentTarget.value);
                }}
                onChange={(e) => {
                  type(e.target.value);
                  if (!ime.current) commit(e.target.value);
                  open('');
                }}
              />
              {q ? (
                <Tool label="清空搜索" onClick={clear}>
                  <X />
                </Tool>
              ) : (
                fold && <kbd aria-hidden="true">⌘K</kbd>
              )}
            </div>
            <SyncTool busy={syncing || !!state.counts.syncing} onClick={sync} />
            {status && (
              <button
                className="sync-status"
                onClick={() =>
                  nav(state.session.expired ? 'settings' : 'outbox')
                }
              >
                {status}
              </button>
            )}
          </header>
          <main className="journal">
            <div className="column">
              {!confirm && <Notice text={err || error} />}
              {confirm && (
                <dialog
                  ref={dialog}
                  role="alertdialog"
                  aria-label="确认操作"
                  className="confirmation"
                  onCancel={(e) => {
                    e.preventDefault();
                    if (!working) cancelConfirmation();
                  }}
                >
                  <strong>
                    {confirm === 'disconnect'
                      ? '断开此设备？'
                      : '删除这份本机原稿？'}
                  </strong>
                  <p>
                    {confirm === 'disconnect'
                      ? count > 0
                        ? `当前账号有 ${count} 条待处理记录。原稿保留在本机，重新登录此账号后可继续同步。`
                        : '断开后，这台 Mac 需要重新登录才能继续使用 Spark。'
                      : '本机原文和暂存图片会一并删除。'}
                  </p>
                  <Notice text={err} />
                  <button
                    autoFocus
                    disabled={working}
                    onClick={cancelConfirmation}
                  >
                    取消
                  </button>
                  <button
                    disabled={working}
                    className="danger"
                    onClick={confirmed}
                  >
                    确认{confirm === 'disconnect' ? '断开' : '删除'}
                  </button>
                </dialog>
              )}
              <section hidden={tab !== 'inbox' || !!detail || !!query}>
                <div className="journal-heading">
                  <p>
                    {greeting(now)}，{todayLine(now)}
                  </p>
                  <h1>收件箱</h1>
                </div>
                <Capture
                  state={state}
                  req={req}
                  inline={{
                    editor,
                    projects,
                    tags,
                    search: () => input.current?.focus(),
                    openRecord: open,
                  }}
                />
              </section>
              {detail ? (
                <div className="journal-view" key={detail}>
                  <button onClick={() => open('')}>
                    <ArrowLeft />
                    返回{title}
                  </button>
                  <Preview
                    req={req}
                    id={detail}
                    localOnly={state.session.expired}
                  />
                  {outbox.find((o) => o.id === detail)?.state ===
                    'needs_review' && (
                    <div className="review">
                      <small>原编号 {detail}</small>
                      <button
                        className="danger"
                        onClick={(e) =>
                          requestConfirmation(detail, e.currentTarget)
                        }
                      >
                        删除本地稿
                      </button>
                    </div>
                  )}
                </div>
              ) : query ? (
                <div className="journal-view" key="search">
                  <h1>搜索结果</h1>
                  <div className="journal-results">
                    <SearchResults
                      hits={hits}
                      query={query}
                      onOpen={open}
                      offline={searchOffline}
                    />
                  </div>
                </div>
              ) : tab === 'settings' ? (
                <div className="journal-view" key="settings">
                  <h1>{title}</h1>
                  <section className="card settings">
                    <h2>外观</h2>
                    <fieldset
                      className="appearance-options"
                      disabled={appearanceBusy}
                    >
                      <legend>手帐配色</legend>
                      <div className="palettes">
                        {PALETTES.map((p) => (
                          <label key={p.id} className="palette-option">
                            <input
                              type="radio"
                              name="palette"
                              checked={state.palette === p.id}
                              onChange={() =>
                                changeAppearance(p.id, state.mode)
                              }
                            />
                            <span className="swatches" aria-hidden="true">
                              {p.swatches.map((color) => (
                                <i
                                  key={color}
                                  style={{ backgroundColor: color }}
                                />
                              ))}
                            </span>
                            <span>{p.label}</span>
                            {state.palette === p.id && (
                              <Check aria-hidden="true" />
                            )}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset
                      className="appearance-options"
                      disabled={appearanceBusy}
                    >
                      <legend>明暗模式</legend>
                      <div className="segments">
                        {(
                          [
                            ['system', '跟随系统', Laptop],
                            ['light', '浅色', Sun],
                            ['dark', '深色', Moon],
                          ] as const
                        ).map(([mode, label, Icon]) => (
                          <label key={mode}>
                            <input
                              type="radio"
                              name="mode"
                              checked={state.mode === mode}
                              onChange={() =>
                                changeAppearance(state.palette, mode)
                              }
                            />
                            <Icon />
                            {label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </section>
                  <section className="card settings">
                    <h2>全局快捷键</h2>
                    {(
                      [
                        [
                          'capture',
                          '随手记',
                          state.capture_key,
                          [
                            'Option+Space',
                            'Control+Option+Space',
                            'Command+Shift+Space',
                          ],
                        ],
                        [
                          'screenshot',
                          '选区截屏',
                          state.screenshot_key,
                          [
                            'Option+Shift+4',
                            'Control+Option+4',
                            'Command+Shift+5',
                          ],
                        ],
                      ] as const
                    ).map(([key, label, val, options]) => (
                      <label key={key}>
                        {label}
                        <select
                          value={val}
                          onChange={(e) =>
                            req('shortcut', 'PUT', {
                              key,
                              value: e.target.value,
                            })
                              .then(refresh)
                              .catch((e) => bad(message(e)))
                          }
                        >
                          {options.map((k) => (
                            <option key={k} value={k}>
                              {formatShortcut(k)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </section>
                  <section className="card settings">
                    <h2>
                      <Laptop /> 设备会话
                    </h2>
                    <p>{state.session.account_label}</p>
                    {expiresAt > 0 && (
                      <small>
                        有效至 {new Date(expiresAt).toLocaleDateString('zh-CN')}
                      </small>
                    )}

                    {state.session.expired && (
                      <Login
                        state={state}
                        onSuccess={() => {
                          refresh();
                          compose();
                        }}
                      />
                    )}
                    <button
                      className="disconnect"
                      onClick={(e) =>
                        requestConfirmation('disconnect', e.currentTarget)
                      }
                    >
                      断开此设备
                    </button>
                  </section>
                </div>
              ) : (
                <div className="journal-view" key={tab}>
                  {tab !== 'inbox' && <h1>{title}</h1>}
                  {visiblePending.length > 0 && (
                    <section className="pending-list">
                      {visiblePending.map((o) => (
                        <button key={o.id} onClick={() => open(o.id)}>
                          <span>
                            <strong>
                              {o.raw_text ||
                                o.attachments?.[0]?.filename ||
                                '随手记'}
                            </strong>
                            <small>{phase[o.state]}</small>
                          </span>
                          <ChevronRight />
                        </button>
                      ))}
                    </section>
                  )}
                  {tab !== 'outbox' &&
                    dayGroups.map(({ stamp, items }) => (
                      <section className="journal-day" key={stamp.key}>
                        <h3
                          className="stamp"
                          data-today={stamp.relative === '今天'}
                          aria-label={stamp.label}
                        >
                          <span>{stamp.relative || stamp.month}</span>
                          <b>{stamp.day}</b>
                          <small>{stamp.weekday}</small>
                        </h3>
                        <div className="day-entries">
                          {items.map((entry) => (
                            <EntryCard
                              key={entry.id}
                              entry={entry}
                              req={req}
                              onOpen={() => open(entry.id)}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  {tab !== 'outbox' && cursor && (
                    <button disabled={busy} onClick={more}>
                      加载更多
                    </button>
                  )}
                  {!visiblePending.length &&
                    (tab === 'outbox' || !entries.length) && (
                      <div className="empty">
                        <JarScene className="empty-art" />
                        <h2>
                          {busy
                            ? '正在读取…'
                            : tab === 'outbox'
                              ? '没有待同步的记录'
                              : '这里还没有收藏'}
                        </h2>
                        {!busy && tab !== 'outbox' && (
                          <button onClick={compose}>记下第一条灵感</button>
                        )}
                      </div>
                    )}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
