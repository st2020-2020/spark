import {
  useEffect,
  useState,
  useId,
  useRef,
  type FormEvent,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { BookOpen, Check, Copy, Link2, RotateCw } from 'lucide-react';
import {
  bridge,
  message,
  type State,
  type Request,
  type Detail,
  detailText,
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
  onClick,
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
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function Login({
  state,
  onSuccess,
  panel = false,
}: {
  state: State;
  onSuccess: () => void;
  panel?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const errorID = useId();
  const [invalid, setInvalid] = useState('');
  const password = useRef<HTMLInputElement>(null);
  const pending = useRef(false);

  useEffect(() => {
    if (!panel || !form.current) return;
    const element = form.current;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      void bridge()('window/resize?height=' + height, 'POST').catch(() => {});
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending.current || !password.current) return;
    const emailField = e.currentTarget.elements.namedItem(
      'email',
    ) as HTMLInputElement;
    const invalidField = !emailField.validity.valid
      ? emailField
      : !password.current.value
        ? password.current
        : null;
    if (invalidField) {
      setInvalid(invalidField.name);
      setError(
        invalidField === emailField ? '请输入有效的邮箱地址。' : '请输入密码。',
      );
      invalidField.focus();
      return;
    }
    setInvalid('');
    pending.current = true;
    setBusy(true);
    setError('');
    const email = emailField.value.trim();
    const request = bridge(state.session.account_id)('session/login', 'POST', {
      email,
      password: password.current.value,
    });
    password.current.value = '';
    try {
      await request;
      onSuccess();
    } catch (e) {
      setError(message(e));
      requestAnimationFrame(() => password.current?.focus());
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="login-form"
      ref={form}
      noValidate
      onSubmit={submit}
      autoComplete="off"
      aria-label="Spark 账号登录"
    >
      <div className="brand">
        <Jar />
        <h1>{state.session.expired ? '重新登录 Spark' : '登录 Spark'}</h1>
      </div>
      {state.session.expired && (
        <p className="login-hint">
          会话已到期。本机记录已保留，登录原账号后继续同步。
        </p>
      )}
      <label>
        邮箱
        <input
          type="email"
          name="email"
          aria-invalid={invalid === 'email'}
          aria-describedby={invalid === 'email' ? errorID : undefined}
          required
          autoFocus
          defaultValue={state.session.account_label || ''}
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
      </label>
      <label>
        密码
        <input
          ref={password}
          type="password"
          name="password"
          aria-invalid={invalid === 'password'}
          aria-describedby={invalid === 'password' ? errorID : undefined}
          required
          autoComplete="off"
          disabled={busy}
        />
      </label>
      <Notice text={error} id={errorID} />
      <button className="primary" type="submit" disabled={busy}>
        {busy ? '正在登录…' : '登录'}
      </button>
    </form>
  );
}
export function Notice({
  text,
  id,
  children,
}: {
  text?: string;
  id?: string;
  children?: ReactNode;
}) {
  return text ? (
    <p id={id} className="notice" role="status">
      <span>{text}</span>
      {children}
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
    [loaded, setLoaded] = useState(false),
    [seq, retry] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setFailed(false);
    setLoaded(false);
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
  return src && !failed ? (
    <img
      className="attachment"
      data-loaded={loaded}
      alt={name}
      src={src}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  ) : failed ? (
    <button onClick={() => retry(seq + 1)}>
      <RotateCw />
      重试图片
    </button>
  ) : (
    <span className="muted">正在读取图片…</span>
  );
}
function CopyAction({
  req,
  link = false,
  text,
  onError,
}: {
  req: Request;
  link?: boolean;
  text: string;
  onError: (error: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      copyRequest.current?.abort();
      clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    copyRequest.current?.abort();
    const request = new AbortController();
    copyRequest.current = request;
    try {
      await req('clipboard/copy', 'POST', { text }, request.signal);
      if (request.signal.aborted) return;
      onError('');
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      if (!request.signal.aborted) onError(message(e));
    }
  }
  const Icon = copied ? Check : link ? Link2 : Copy;
  return (
    <button onClick={copy}>
      <Icon />
      <span aria-live="polite">
        {copied ? '已复制' : link ? '复制链接' : '复制正文'}
      </span>
    </button>
  );
}
export function Preview({ req, id }: { req: Request; id: string }) {
  const [d, set] = useState<Detail>(),
    [err, bad] = useState(''),
    [actionError, setActionError] = useState(''),
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
  const { url, body } = detailText(d);
  return (
    <article className="detail">
      <small>
        {item ? phase[item.state] : d.offline ? '离线缓存' : '已同步'}
      </small>
      <h2>
        {col?.display_title || item?.raw_text.split('\n')[0] || '图片收藏'}
      </h2>
      <p className="multiline">{body}</p>
      {url && <p className="linktext">{url}</p>}
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
      <Notice text={actionError} />
      <div className="detail-actions">
        {body && <CopyAction req={req} text={body} onError={setActionError} />}
        {url && (
          <CopyAction req={req} link text={url} onError={setActionError} />
        )}
        {col && (
          <button
            onClick={() =>
              req('window/web?id=' + id, 'POST').catch((e) =>
                setActionError(message(e)),
              )
            }
          >
            <BookOpen />
            在网页版打开 ↗
          </button>
        )}
      </div>
    </article>
  );
}
