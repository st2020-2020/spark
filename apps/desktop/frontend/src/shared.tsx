import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { BookOpen, Link2, LoaderCircle, RotateCw } from 'lucide-react';
import {
  bridge,
  message,
  type State,
  type Request,
  type Detail,
  plain,
  phase,
} from './bridge';

export function Jar() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="jar">
      <rect
        x="7.4"
        y="2.4"
        width="9.2"
        height="3.3"
        rx="1.5"
        fill="currentColor"
      />
      <path
        d="M8.6 5.7v1.5C6.5 8.1 5 10 5 12.5v4.4c0 2.5 2 4.6 4.6 4.6h4.8c2.6 0 4.6-2.1 4.6-4.6v-4.4c0-2.5-1.5-4.4-3.6-5.3V5.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path
        d="m12 10 1.5 3.5L17 15l-3.5 1.5L12 20l-1.5-3.5L7 15l3.5-1.5z"
        fill="var(--sp-spark-strong)"
      />
    </svg>
  );
}
export function Tool({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="tool"
      title={label}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function Pair({
  state,
  refresh,
}: {
  state: State;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = state.pair.status === 'pending';
  async function start() {
    setBusy(true);
    setError('');
    try {
      await bridge()('pair/start', 'POST');
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pair">
      <div className="brand">
        <Jar /> Spark
      </div>
      <h1>连接你的 Spark 空间</h1>
      <p>在系统浏览器中确认账号，这台 Mac 就能收下笔记，再同步到你的手帐。</p>
      {pending ? (
        <>
          <output className="code">{state.pair.short_code}</output>
          <p>
            请核对浏览器中的比对码，区分大小写。有效至{' '}
            {new Date(state.pair.expires_at).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
            。
          </p>
        </>
      ) : null}
      <button className="primary" disabled={busy} onClick={start}>
        {busy ? <LoaderCircle /> : <Link2 />}
        {pending ? '重新打开配对页' : '在浏览器中连接'}
      </button>
      <small>{state.origin}</small>
      <Notice
        text={
          error ||
          state.pair.message ||
          (state.pair.status === 'expired' ? '比对码已过期，请重新连接。' : '')
        }
      />
    </section>
  );
}
export function Notice({ text }: { text?: string }) {
  return text ? (
    <p className="notice" role="status">
      {text}
    </p>
  ) : null;
}
export function ImageView({
  req,
  id,
  owner,
  name,
}: {
  req: Request;
  id: string;
  owner?: string;
  name: string;
}) {
  const [src, setSrc] = useState(''),
    [failed, setFailed] = useState(false),
    [seq, retry] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setFailed(false);
    setSrc('');
    req<{ mime: string; data: string }>(
      'image/' + id + (owner ? '?outbox=' + owner : ''),
      'GET',
      undefined,
      ctrl.signal,
    )
      .then((v) => setSrc('data:' + v.mime + ';base64,' + v.data))
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [req, id, owner, seq]);
  return src ? (
    <img className="attachment" alt={name} src={src} />
  ) : failed ? (
    <button onClick={() => retry(seq + 1)}>
      <RotateCw />
      重试图片
    </button>
  ) : (
    <span className="muted">正在读取图片…</span>
  );
}
export function Preview({ req, id }: { req: Request; id: string }) {
  const [d, set] = useState<Detail>(),
    [err, bad] = useState(''),
    [version, retry] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    set(undefined);
    bad('');
    req<Detail>('collections/' + id, 'GET', undefined, c.signal)
      .then(set)
      .catch((e) => {
        if (!c.signal.aborted) bad(message(e));
      });
    return () => c.abort();
  }, [id, req, version]);
  if (err)
    return (
      <div>
        <Notice text={err} />
        <button onClick={() => retry(version + 1)}>重试</button>
      </div>
    );
  if (!d) return <p role="status">正在读取…</p>;
  const item = d.item,
    col = d.collection;
  return (
    <article className="detail">
      <small>
        {item ? phase[item.state] : d.offline ? '离线缓存' : '已同步'}
      </small>
      <h2>
        {col?.display_title || item?.raw_text.split('\n')[0] || '图片收藏'}
      </h2>
      <p className="multiline">
        {item?.raw_text || plain(col?.document?.content) || col?.plain_text}
      </p>
      {(item?.original_url || col?.original_url) && (
        <p className="linktext">{item?.original_url || col?.original_url}</p>
      )}
      {(col?.attachments || item?.attachments)?.map((f) => (
        <ImageView
          key={f.id}
          req={req}
          id={f.id}
          owner={item?.id}
          name={f.filename}
        />
      ))}
      {(item?.intent || col?.intent) && (
        <p>用途 · {item?.intent || col?.intent}</p>
      )}
      {col?.organization?.summary && (
        <p>整理摘要 · {col.organization.summary}</p>
      )}
      {col?.image_notes?.map((n, i) => <p key={i}>{n.text}</p>)}
      {item && <Notice text={item.last_error_message} />}
      {col && (
        <button
          onClick={() =>
            req('window/web?id=' + id, 'POST').catch((e) => bad(message(e)))
          }
        >
          <BookOpen />
          在网页版打开 ↗
        </button>
      )}
    </article>
  );
}
