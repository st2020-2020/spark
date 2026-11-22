import { useEffect, useState, useRef } from 'react';
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
  X,
} from 'lucide-react';
import {
  active,
  dateLabel,
  message,
  phase,
  type Choice,
  type Outbox,
  type Request,
  type State,
  type Summary,
} from './bridge';
import { ImageView, Jar, Notice, Login, Preview, Tool } from './shared';
import { useSearch } from './Search';
type Props = { state: State; req: Request; refresh: () => void };
export function Book({ state, req, refresh }: Props) {
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
    [working, work] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    ime = useRef(false),
    serial = useRef(0),
    { hits, error, offline: searchOffline } = useSearch(req, query, !!query);
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
  const count = Object.values(state.counts).reduce((a, b) => a + (b || 0), 0);
  function nav(t: string) {
    tabTo(t);
    open('');
    type('');
    commit('');
    bad('');
  }
  useEffect(() => {
    const change = () => update((r) => r + 1),
      select = (e: Event) => open((e as CustomEvent).detail);
    const key = (e: KeyboardEvent) => {
      if (!e.metaKey || e.isComposing || e.keyCode === 229) return;
      if (e.key === '\\') {
        e.preventDefault();
        collapse((v) => !v);
      } else if (e.key === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('spark-state', change);
    window.addEventListener('spark-detail', select);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('spark-state', change);
      window.removeEventListener('spark-detail', select);
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
  }, [req, pid, tid, rev]);
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
    work(true);
    bad('');
    try {
      await req('sync/now', 'POST');
      off(false);
      update((v) => v + 1);
    } catch (e) {
      bad(message(e));
      off(true);
    } finally {
      work(false);
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
  return (
    <div className="book">
      <header className="titlebar">
        <Tool
          label={fold ? '展开侧栏' : '折叠侧栏'}
          onClick={() => collapse(!fold)}
        >
          <PanelLeft />
        </Tool>
        <span>{title}</span>
        <div className="searchbox">
          <Search />
          <input
            ref={input}
            value={q}
            placeholder="搜索手帐　⌘K"
            aria-label="搜索手帐"
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
          {q && (
            <Tool label="清空搜索" onClick={clear}>
              <X />
            </Tool>
          )}
        </div>
        <Tool label="立即同步" disabled={working} onClick={sync}>
          <RefreshCw />
        </Tool>
        <button className="chip" onClick={() => nav('settings')}>
          {state.session.expired
            ? '重新登录'
            : offline
              ? '离线模式'
              : count
                ? count + ' 条待处理'
                : '本机状态'}
        </button>
      </header>
      <div className="workspace">
        {!fold && (
          <aside style={{ width }}>
            <div className="brand">
              <Jar />
              Spark
            </div>
            <button
              className="primary compose"
              onClick={() => req('window/panel', 'POST')}
            >
              <NotebookPen />
              随手记 <kbd>{state.capture_key.replace('Option+', '⌥')}</kbd>
            </button>
            <nav>
              {[
                ['inbox', Inbox, '收件箱'],
                ['all', BookOpen, '全部收藏'],
                ['outbox', Archive, '本机发件箱'],
              ].map(([value, Icon, label]) => {
                const I = Icon as typeof Inbox;
                return (
                  <button
                    key={String(value)}
                    className={tab === value ? 'chosen' : ''}
                    onClick={() => nav(String(value))}
                  >
                    <I />
                    {String(label)}
                    {value === 'outbox' && count > 0 && <small>{count}</small>}
                  </button>
                );
              })}
              {projects.length > 0 && <h3>项目</h3>}
              {projects.map((p, i) => (
                <button
                  className={pid === p.id ? 'chosen' : ''}
                  key={p.id}
                  onClick={() => nav('p:' + p.id)}
                >
                  <i className={'tone tone-' + (i % 6)} />
                  {p.name}
                  <small>{p.collection_count}</small>
                </button>
              ))}
              {tags.length > 0 && <h3>标签</h3>}
              {tags.map((t) => (
                <button
                  className={tid === t.id ? 'chosen' : ''}
                  key={t.id}
                  onClick={() => nav('t:' + t.id)}
                >
                  # {t.name}
                  <small>{t.collection_count}</small>
                </button>
              ))}
            </nav>
            <button className="account" onClick={() => nav('settings')}>
              <Settings2 />
              {state.session.account_label}
            </button>
            <div
              role="separator"
              aria-label="调整侧栏宽度"
              aria-orientation="vertical"
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
        <main className="journal">
          <div className="column">
            <Notice text={err || error} />
            {confirm && (
              <div
                role="alertdialog"
                aria-label="确认操作"
                className="confirmation"
              >
                <strong>
                  {confirm === 'disconnect'
                    ? '断开此设备？'
                    : '删除这份本机原稿？'}
                </strong>
                <p>
                  {confirm === 'disconnect'
                    ? `当前账号有 ${count} 条待处理记录。原稿保留在本机，重新登录此账号后可继续同步。`
                    : '本机原文和暂存图片会一并删除。'}
                </p>
                <button autoFocus onClick={() => ask('')}>
                  取消
                </button>
                <button
                  disabled={working}
                  className="danger"
                  onClick={confirmed}
                >
                  确认{confirm === 'disconnect' ? '断开' : '删除'}
                </button>
              </div>
            )}
            {detail ? (
              <>
                <button onClick={() => open('')}>
                  <ArrowLeft />
                  返回{title}
                </button>
                <Preview req={req} id={detail} />
                {outbox.find((o) => o.id === detail)?.state ===
                  'needs_review' && (
                  <div className="review">
                    <small>原编号 {detail}</small>
                    <button
                      onClick={() =>
                        req('clipboard/copy', 'POST', {
                          text: outbox.find((o) => o.id === detail)?.raw_text,
                        })
                      }
                    >
                      复制原稿
                    </button>
                    <button className="danger" onClick={() => ask(detail)}>
                      删除本地稿
                    </button>
                  </div>
                )}
              </>
            ) : query ? (
              <>
                <h1>搜索结果</h1>
                {hits.map((h) => (
                  <button
                    className="card"
                    key={h.id}
                    onClick={() => open(h.id)}
                  >
                    <strong>{h.display_title}</strong>
                    <p>{h.snippet}</p>
                  </button>
                ))}
                {!hits.length && <p>没有找到相关收藏。</p>}
                {searchOffline && <small>离线模式 · 仅搜索本机缓存</small>}
              </>
            ) : tab === 'settings' ? (
              <>
                <h1>{title}</h1>
                <section className="card settings">
                  <h2>连接的空间</h2>
                  <p>{state.session.account_label}</p>
                  <small>
                    有效至{' '}
                    {new Date(
                      state.session.expires_at || '',
                    ).toLocaleDateString('zh-CN')}
                  </small>
                  {state.session.expired && (
                    <Login
                      state={state}
                      onSuccess={() => {
                        refresh();
                        void req('window/panel', 'POST');
                      }}
                    />
                  )}
                  <button onClick={() => ask('disconnect')}>断开此设备</button>
                </section>
                <section className="card settings">
                  <h2>外观</h2>
                  <label>
                    手帐配色
                    <select
                      value={state.palette}
                      onChange={(e) =>
                        req('prefs', 'PUT', {
                          palette: e.target.value,
                          mode: state.mode,
                        })
                          .then(refresh)
                          .catch((e) => bad(message(e)))
                      }
                    >
                      {[
                        ['mint', '薄荷晨雾'],
                        ['sea', '晴海'],
                        ['matcha', '抹茶'],
                        ['sakura', '樱花'],
                      ].map(([v, k]) => (
                        <option key={v} value={v}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    明暗模式
                    <select
                      value={state.mode}
                      onChange={(e) =>
                        req('prefs', 'PUT', {
                          palette: state.palette,
                          mode: e.target.value,
                        })
                          .then(refresh)
                          .catch((e) => bad(message(e)))
                      }
                    >
                      {[
                        ['system', '跟随系统'],
                        ['light', '浅色'],
                        ['dark', '深色'],
                      ].map(([v, k]) => (
                        <option key={v} value={v}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </label>
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
                          req('shortcut', 'PUT', { key, value: e.target.value })
                            .then(refresh)
                            .catch((e) => bad(message(e)))
                        }
                      >
                        {options.map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </section>
              </>
            ) : (
              <>
                <h1>{title}</h1>
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
                  entries.map((entry, i) => (
                    <section key={entry.id}>
                      {(!i ||
                        dateLabel(entry.created_at) !==
                          dateLabel(entries[i - 1].created_at)) && (
                        <h3 className="stamp">{dateLabel(entry.created_at)}</h3>
                      )}
                      <button className="card" onClick={() => open(entry.id)}>
                        <strong>{entry.display_title}</strong>
                        <p>{entry.excerpt}</p>
                        {entry.cover_attachment_id && (
                          <ImageView
                            req={req}
                            id={entry.cover_attachment_id}
                            name="收藏缩略图"
                          />
                        )}
                        <span className="labels">
                          {entry.projects
                            ?.filter((p) => active(p.decision))
                            .map((p) => (
                              <small key={p.project_id} className="washi">
                                {p.name}
                              </small>
                            ))}
                          {entry.tags
                            ?.filter((t) => active(t.decision))
                            .map((t) => (
                              <small key={t.tag_id}># {t.path}</small>
                            ))}
                        </span>
                      </button>
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
                      <Jar />
                      <h2>
                        {busy
                          ? '正在读取…'
                          : tab === 'outbox'
                            ? '没有待同步的记录'
                            : '这里还没有收藏'}
                      </h2>
                      {!busy && tab !== 'outbox' && (
                        <button onClick={() => req('window/panel', 'POST')}>
                          记下第一条灵感
                        </button>
                      )}
                    </div>
                  )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
