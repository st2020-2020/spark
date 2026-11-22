import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  AtSign,
  Camera,
  Clipboard,
  FileImage,
  Link2,
  NotebookPen,
  Plus,
  Search as Lens,
  X,
} from 'lucide-react';
import {
  detectURL,
  fileImage,
  message,
  type Choice,
  type FileImage as ImageFile,
  type Request,
  type State,
  type Outbox,
} from './bridge';
import { Notice, Tool } from './shared';
import { Search } from './Search';

export function Panel({ req, state }: { req: Request; state: State }) {
  const [text, write] = useState(''),
    [intent, purpose] = useState(''),
    [showIntent, expand] = useState(false),
    [images, attach] = useState<ImageFile[]>([]),
    [removed, removeURL] = useState(''),
    [search, find] = useState(false);
  const [projects, setProjects] = useState<Choice[]>([]),
    [tags, setTags] = useState<Choice[]>([]),
    [projectIDs, pickP] = useState<string[]>([]),
    [tagIDs, pickT] = useState<string[]>([]);
  const [clip, setClip] = useState<{
      image?: string;
      text?: string;
      available: boolean;
    }>(),
    [err, bad] = useState(''),
    [busy, saving] = useState(false),
    [drag, dragging] = useState(false),
    [last, saved] = useState<{ id: string; at: number }>();
  const [mention, suggest] = useState<{
      kind: string;
      start: number;
      end: number;
      term: string;
    } | null>(null),
    [active, select] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null),
    picker = useRef<HTMLInputElement>(null),
    root = useRef<HTMLDivElement>(null),
    pending = useRef(false),
    ime = useRef(false);
  const url = detectURL(text);
  const linked = url !== removed ? url : '';
  const choices = (mention?.kind === '@' ? projects : tags)
    .filter((c) =>
      c.name.toLowerCase().includes(mention?.term.toLowerCase() || ''),
    )
    .slice(0, 6);
  function changed(v: string, pos: number) {
    write(v);
    const m = /(?:^|\s)([@#])([^\s@#]*)$/u.exec(v.slice(0, pos));
    suggest(
      m && !ime.current
        ? { kind: m[1], term: m[2], start: pos - m[2].length - 1, end: pos }
        : null,
    );
    select(0);
  }
  function choose(c: Choice) {
    if (!mention) return;
    const pick = mention.kind === '@' ? pickP : pickT;
    pick((prev) => (prev.includes(c.id) ? prev : [...prev, c.id]));
    write(text.slice(0, mention.start) + text.slice(mention.end));
    suggest(null);
    editor.current?.focus();
  }
  function push(files: ImageFile[]) {
    attach((prev) => {
      if (prev.length + files.length > 9) {
        bad('单条收藏最多附带 9 张图片。');
        return prev;
      }
      return [...prev, ...files];
    });
  }
  async function add(files: File[]) {
    try {
      if (images.length + files.length > 9)
        throw new Error('单条收藏最多附带 9 张图片。');
      push(await Promise.all(files.map(fileImage)));
    } catch (e) {
      bad(message(e));
    }
  }
  const append = (value: string) => {
    write((v) => (v ? v + '\n' : '') + value);
    editor.current?.focus();
  };
  function dismiss() {
    setClip(undefined);
    void req('clipboard/dismiss', 'POST').catch((e) => bad(message(e)));
  }
  function takeClip() {
    if (clip?.image)
      push([
        { filename: '剪贴板.png', mime: 'image/png', data_b64: clip.image },
      ]);
    else if (clip?.text) append(clip.text);
    dismiss();
  }
  useLayoutEffect(() => {
    if (editor.current) {
      editor.current.style.height = 'auto';
      editor.current.style.height =
        Math.min(220, editor.current.scrollHeight) + 'px';
    }
  }, [text, search]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let height = 0;
    const o = new ResizeObserver(() => {
      const n = Math.ceil(el.getBoundingClientRect().height);
      if (n !== height) {
        height = n;
        void req('window/resize?height=' + n, 'POST').catch(() => {});
      }
    });
    o.observe(el);
    return () => o.disconnect();
  }, [req]);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [p, t] = await Promise.all([
          req<Choice[]>('projects'),
          req<Choice[]>('tags'),
        ]);
        if (live) {
          setProjects(p);
          setTags(t);
        }
      } catch (e) {
        if (live) bad(message(e));
      }
    }
    function refresh() {
      if (document.visibilityState === 'hidden') return;
      req<typeof clip>('clipboard')
        .then((v) => {
          if (live) setClip(v);
        })
        .catch(() => {});
    }
    function show() {
      void load();
      refresh();
      requestAnimationFrame(() => editor.current?.focus());
      saved((v) => (v && Date.now() - v.at < 3000 ? v : undefined));
    }
    const image = (evt: Event) => {
      const d = (evt as CustomEvent).detail;
      if (d.account === state.session.account_id) {
        find(false);
        push([{ filename: d.filename, data_b64: d.data, mime: 'image/png' }]);
      }
    };
    const error = (evt: Event) => bad((evt as CustomEvent).detail);
    show();
    const timer = setInterval(refresh, 1500);
    window.addEventListener('spark-show', show);
    window.addEventListener('spark-image', image);
    window.addEventListener('spark-error', error);
    window.addEventListener('spark-state', load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('spark-show', show);
      window.removeEventListener('spark-image', image);
      window.removeEventListener('spark-error', error);
      window.removeEventListener('spark-state', load);
    };
  }, [req, state.session.account_id]);
  async function save() {
    if (pending.current || (!text.trim() && !images.length)) return;
    pending.current = true;
    saving(true);
    bad('');
    try {
      const result = await req<{ item: Outbox }>('capture', 'POST', {
        raw_text: text,
        intent,
        original_url: linked,
        suppress_url: !linked,
        project_ids: projectIDs,
        tag_ids: tagIDs,
        attachments: images.map(({ filename, data_b64 }) => ({
          filename,
          data_b64,
        })),
      });
      write('');
      purpose('');
      attach([]);
      pickP([]);
      pickT([]);
      removeURL('');
      expand(false);
      suggest(null);
      saved({ id: result.item.id, at: Date.now() });
      await req('window/hide', 'POST');
    } catch (e) {
      bad(message(e));
    } finally {
      pending.current = false;
      saving(false);
    }
  }
  function leaveSearch() {
    find(false);
    requestAnimationFrame(() => editor.current?.focus());
  }
  return (
    <div
      ref={root}
      className="paper panel"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229 || ime.current)
          return;
        if (e.metaKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          search ? leaveSearch() : find(true);
        } else if (e.metaKey && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          void req('window/main', 'POST');
        } else if (
          mention &&
          choices.length &&
          ['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)
        ) {
          e.preventDefault();
          if (e.key === 'Enter') choose(choices[active] || choices[0]);
          else
            select(
              (active + choices.length + (e.key === 'ArrowDown' ? 1 : -1)) %
                choices.length,
            );
        } else if (e.key === 'Escape') {
          if (mention) suggest(null);
          else if (!search) void req('window/hide', 'POST');
        } else if (!search && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void save();
        } else if (
          e.key === 'Tab' &&
          !e.shiftKey &&
          clip?.available &&
          e.target === editor.current
        ) {
          e.preventDefault();
          takeClip();
        }
      }}
    >
      {search ? (
        <Search req={req} back={leaveSearch} />
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            dragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node))
              dragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragging(false);
            if (e.dataTransfer.files.length)
              void add([...e.dataTransfer.files]);
            else
              append(
                e.dataTransfer.getData('text/uri-list') ||
                  e.dataTransfer.getData('text/plain'),
              );
          }}
        >
          <div className="tape" />
          <textarea
            ref={editor}
            aria-label="记录灵感"
            placeholder="刚刚想到什么？"
            rows={3}
            value={text}
            disabled={busy}
            onCompositionStart={() => {
              ime.current = true;
              suggest(null);
            }}
            onCompositionEnd={(e) => {
              ime.current = false;
              changed(e.currentTarget.value, e.currentTarget.selectionStart);
            }}
            onChange={(e) => {
              if (e.target.value === '/' && !text && !ime.current) {
                find(true);
                return;
              }
              changed(e.target.value, e.target.selectionStart);
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                void add([...e.clipboardData.files]);
              }
            }}
          />
          {clip?.available && (
            <div className="capsule">
              <button onClick={takeClip}>
                <Clipboard />
                <span>{clip.image ? '刚复制的图片' : clip.text}</span>
                <kbd>Tab</kbd>
              </button>
              <Tool label="忽略剪贴板建议" onClick={dismiss}>
                <X />
              </Tool>
            </div>
          )}
          {mention && choices.length > 0 && (
            <div
              className="choices"
              role="listbox"
              aria-label={mention.kind === '@' ? '选择项目' : '选择标签'}
            >
              {choices.map((c, i) => (
                <button
                  key={c.id}
                  role="option"
                  aria-selected={i === active}
                  onClick={() => choose(c)}
                >
                  {mention.kind} {c.name}
                </button>
              ))}
            </div>
          )}
          <div className="chips">
            {linked && (
              <button
                className="chip"
                title="移除网址关联"
                onClick={() => removeURL(linked)}
              >
                <Link2 />
                {new URL(linked).hostname}
                <X />
              </button>
            )}
            {[
              ...projectIDs.map((id) => ({ id, p: true })),
              ...tagIDs.map((id) => ({ id, p: false })),
            ].map(({ id, p }) => (
              <button
                className={'chip ' + (p ? 'washi' : '')}
                key={id}
                onClick={() =>
                  (p ? pickP : pickT)((ids) => ids.filter((x) => x !== id))
                }
              >
                {p ? '@' : '#'}{' '}
                {(p ? projects : tags).find((t) => t.id === id)?.name}
                <X />
              </button>
            ))}
          </div>
          {images.length > 0 && (
            <div className="thumbs">
              {images.map((f, i) => (
                <button
                  key={i}
                  aria-label={'移除 ' + f.filename}
                  onClick={() => attach(images.filter((_, n) => i !== n))}
                >
                  <img
                    src={'data:' + f.mime + ';base64,' + f.data_b64}
                    alt={f.filename}
                  />
                  <X />
                </button>
              ))}
            </div>
          )}
          {showIntent && (
            <input
              className="intent"
              autoFocus
              aria-label="用途"
              value={intent}
              onChange={(e) => purpose(e.target.value)}
              placeholder="补一句用途，方便归类…"
            />
          )}
          <div className="toolbar">
            <Tool
              label="选区截屏"
              onClick={() => req('window/screenshot', 'POST')}
            >
              <Camera />
            </Tool>
            <Tool label="添加图片" onClick={() => picker.current?.click()}>
              <FileImage />
            </Tool>
            <input
              ref={picker}
              hidden
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                void add([...(e.target.files || [])]);
                e.target.value = '';
              }}
            />
            <Tool
              label="选择项目"
              onClick={() => {
                const v = text + (text ? ' @' : '@');
                changed(v, v.length);
                editor.current?.focus();
              }}
            >
              <AtSign />
            </Tool>
            <button onClick={() => expand(!showIntent)}>
              <Plus />
              用途
            </button>
            <i />
            <Tool label="快搜 ⌘K" onClick={() => find(true)}>
              <Lens />
            </Tool>
            <button
              className="primary save"
              disabled={busy || (!text.trim() && !images.length)}
              onClick={save}
            >
              {busy ? '保存中' : '收下'} <kbd>⌘↵</kbd>
            </button>
          </div>
          {text.length + intent.length > 40000 && (
            <small>{Array.from(text + intent).length} / 50,000</small>
          )}
          {last && Date.now() - last.at < 3000 && (
            <button
              className="sub"
              onClick={() => req('window/main?id=' + last.id, 'POST')}
            >
              <NotebookPen />
              本机已收下 · 查看刚才的记录 <ArrowUpRight />
            </button>
          )}
          <Notice text={err} />
          {err.includes('屏幕录制') && (
            <button onClick={() => req('window/settings', 'POST')}>
              前往系统设置
            </button>
          )}
          {state.session.expired && (
            <div className="sub">
              同步已暂停{' '}
              <button onClick={() => req('pair/start', 'POST')}>
                重新配对
              </button>
              {state.pair.status === 'pending' && (
                <b>{state.pair.short_code}</b>
              )}
            </div>
          )}
          {drag && (
            <div className="drop">松手加入这条随手记（最多 9 张图）</div>
          )}
        </div>
      )}
    </div>
  );
}
