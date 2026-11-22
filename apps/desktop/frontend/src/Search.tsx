import { useEffect, useState, useRef } from 'react';
import { Search as Lens, X, FileText, Copy, Eye } from 'lucide-react';
import {
  type Hit,
  type Summary,
  type Request,
  type Detail,
  message,
  phase,
  plain,
} from './bridge';
import { Tool, Notice, Preview } from './shared';
export function useSearch(req: Request, q: string, enabled = true) {
  const [local, setLocal] = useState<Hit[]>([]),
    [remote, setRemote] = useState<Hit[]>([]),
    [offline, off] = useState(false),
    [error, bad] = useState('');
  useEffect(() => {
    const c = new AbortController();
    setLocal([]);
    setRemote([]);
    off(false);
    bad('');
    if (!enabled) return;
    req<Hit[]>(
      'search/local?q=' + encodeURIComponent(q),
      'GET',
      undefined,
      c.signal,
    )
      .then(setLocal)
      .catch((e) => {
        if (!c.signal.aborted) bad(message(e));
      });
    const timer = setTimeout(() => {
      if (q.trim())
        req<{ items: { collection: Summary; snippets: { text: string }[] }[] }>(
          'search/remote?q=' + encodeURIComponent(q),
          'GET',
          undefined,
          c.signal,
        )
          .then((v) =>
            setRemote(
              (v.items || []).map((x) => ({
                id: x.collection.id,
                created_at: x.collection.created_at,
                original_url: x.collection.original_url,
                display_title: x.collection.display_title,
                snippet: x.snippets?.[0]?.text || x.collection.excerpt || '',
                sync_state: 'synced',
              })),
            ),
          )
          .catch(() => {
            if (!c.signal.aborted) off(true);
          });
    }, 180);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [q, req, enabled]);
  return {
    hits: [
      ...local,
      ...remote.filter((r) => !local.some((l) => r.id === l.id)),
    ],
    offline,
    error,
  };
}
export function Search({ req, back }: { req: Request; back: () => void }) {
  const [q, query] = useState(''),
    [committed, commit] = useState(''),
    [selected, pick] = useState(''),
    [preview, show] = useState(false),
    [feedback, say] = useState('');
  const { hits, offline, error } = useSearch(req, committed),
    focus = useRef<HTMLInputElement>(null),
    ime = useRef(false);
  const index = Math.max(
    0,
    hits.findIndex((h) => h.id === selected),
  );
  const hit = hits[index];
  const set = (v: string) => {
    query(v);
    if (!ime.current) commit(v);
    show(false);
    say('');
  };
  useEffect(() => {
    focus.current?.focus();
  }, []);
  async function copy() {
    if (!hit) return;
    try {
      const d = await req<Detail>('collections/' + hit.id);
      const text =
        d.item?.original_url ||
        d.collection?.original_url ||
        d.item?.raw_text ||
        plain(d.collection?.document?.content) ||
        d.collection?.plain_text;
      if (!text) {
        await req('clipboard/copy-image?id=' + hit.id, 'POST');
      } else await req('clipboard/copy', 'POST', { text });
      say('已复制');
    } catch (e) {
      say(message(e));
    }
  }
  return (
    <section
      className="search-view"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (preview) show(false);
          else if (q) set('');
          else back();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          pick(
            hits[
              Math.max(
                0,
                Math.min(
                  hits.length - 1,
                  index + (e.key === 'ArrowDown' ? 1 : -1),
                ),
              )
            ]?.id || '',
          );
          show(false);
        } else if (e.key === 'Enter' && hit) {
          e.preventDefault();
          show(!preview);
        } else if (
          e.metaKey &&
          e.key.toLowerCase() === 'c' &&
          !window.getSelection()?.toString() &&
          focus.current?.selectionStart === focus.current?.selectionEnd
        ) {
          e.preventDefault();
          void copy();
        } else if (e.metaKey && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          e.stopPropagation();
          void req('window/main?id=' + (hit?.id || ''), 'POST');
        } else if (e.key === ' ' && e.target !== focus.current) {
          e.preventDefault();
          show(!preview);
        }
      }}
    >
      <header>
        <Lens />
        <input
          ref={focus}
          aria-label="搜索收藏"
          placeholder="搜索标题、正文、截图文字或项目…"
          value={q}
          onCompositionStart={() => (ime.current = true)}
          onCompositionEnd={(e) => {
            ime.current = false;
            commit(e.currentTarget.value);
          }}
          onChange={(e) => set(e.target.value)}
        />
        {q && (
          <Tool
            label="清空搜索"
            onClick={() => {
              set('');
              focus.current?.focus();
            }}
          >
            <X />
          </Tool>
        )}
        <button onClick={back}>记一条</button>
      </header>
      <div className="results">
        {hits.map((h, i) => (
          <button
            className={'hit ' + (i === index ? 'chosen' : '')}
            key={h.id}
            onClick={() => {
              pick(h.id);
              show(true);
            }}
          >
            <FileText />
            <span>
              <strong>{h.display_title}</strong>
              <small>{h.snippet}</small>
            </span>
            {h.sync_state !== 'synced' && <small>{phase[h.sync_state]}</small>}
          </button>
        ))}
        {!hits.length && (
          <p className="empty">{q ? '没有找到相关收藏' : '还没有最近收藏'}</p>
        )}
        {preview && hit && <Preview req={req} id={hit.id} />}
      </div>
      <footer>
        <Tool
          label="预览选中收藏"
          disabled={!hit}
          onClick={() => show(!preview)}
        >
          <Eye />
        </Tool>
        <button disabled={!hit} onClick={copy}>
          <Copy />
          复制 <kbd>⌘C</kbd>
        </button>
        <small>{offline ? '离线 · 仅搜索本机缓存' : '↑ ↓ 选择　↵ 预览'}</small>
      </footer>
      <Notice text={error || feedback} />
    </section>
  );
}
