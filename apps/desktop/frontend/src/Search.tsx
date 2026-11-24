import { projectToneClass } from '../../../web/src/lib/projectTone';
import { useEffect, useState, useRef } from 'react';
import { Search as Lens, X, FileText, Link2, FileImage } from 'lucide-react';
import {
  active,
  type Hit,
  type Summary,
  type Request,
  type Detail,
  message,
  phase,
  detailText,
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
                projects: x.collection.projects,
                primary_type: x.collection.primary_type,
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
function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const escaped = words.map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const parts = text.split(new RegExp('(' + escaped.join('|') + ')', 'iu'));
  return (
    <>{parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>
  );
}

export function SearchResults({
  hits,
  query,
  currentID,
  onOpen,
  offline,
}: {
  hits: Hit[];
  query: string;
  currentID?: string;
  onOpen: (id: string) => void;
  offline: boolean;
}) {
  const currentRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRow.current?.scrollIntoView({ block: 'nearest' });
  }, [currentID]);
  return (
    <>
      {hits.map((h) => {
        const project = h.projects?.find((p) => p.name && active(p.decision));
        const Icon =
          h.primary_type === 'image'
            ? FileImage
            : h.primary_type === 'url'
              ? Link2
              : FileText;
        return (
          <button
            className={'hit ' + (h.id === currentID ? 'chosen' : '')}
            key={h.id}
            ref={h.id === currentID ? currentRow : undefined}
            aria-current={h.id === currentID}
            onClick={() => onOpen(h.id)}
          >
            <Icon />
            <span>
              <strong>
                <Highlight text={h.display_title} query={query} />
              </strong>
              <small>
                <Highlight text={h.snippet} query={query} />
              </small>
            </span>
            {h.sync_state !== 'synced' ? (
              <small className="sync-status">{phase[h.sync_state]}</small>
            ) : (
              project && (
                <small
                  className={'washi ' + projectToneClass(project.project_id)}
                >
                  {project.name}
                </small>
              )
            )}
          </button>
        );
      })}
      {!hits.length && (
        <p className="empty">{query ? '没有找到相关收藏' : '还没有最近收藏'}</p>
      )}
      {offline && <small className="offline-note">离线 · 仅搜索本机缓存</small>}
    </>
  );
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
  function escape() {
    if (preview) show(false);
    else if (q) set('');
    else back();
  }
  const openBook = () =>
    req('window/main?id=' + (hit?.id || ''), 'POST').catch((e) =>
      say(message(e)),
    );
  async function copy() {
    if (!hit) return;
    try {
      const d = await req<Detail>('collections/' + hit.id);
      const { url, body } = detailText(d);
      const text = url || body;
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
          escape();
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
        } else if (e.key === 'Enter' && hit && e.target === focus.current) {
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
          void openBook();
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
        <SearchResults
          hits={hits}
          query={committed}
          currentID={hit?.id}
          offline={offline}
          onOpen={(id) => {
            pick(id);
            show(true);
          }}
        />
        {preview && hit && <Preview key={hit.id} req={req} id={hit.id} />}
      </div>
      <footer>
        <button disabled={!hit} onClick={() => show(!preview)}>
          <kbd>↵</kbd>预览
        </button>
        <button disabled={!hit} onClick={copy}>
          <kbd>⌘C</kbd>复制即走
        </button>
        <button onClick={openBook}>
          <kbd>⌘O</kbd>打开手帐
        </button>
        <button onClick={escape}>
          <kbd>Esc</kbd>返回
        </button>
      </footer>

      <Notice text={error || feedback} />
    </section>
  );
}
