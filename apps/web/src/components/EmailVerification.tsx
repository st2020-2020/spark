import { useEffect, useRef, useState } from 'react';
import type { VerificationRequest } from '../api/types';
import { ApiError, getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import type { TestAdapter } from '../test-adapter/mockServer';

type Purpose = VerificationRequest['purpose'];

export function useEmailVerification(purpose: Purpose) {
  const api = useApi();
  const request = useRef(0);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; expiresAt: number } | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [simulatedCode, setSimulatedCode] = useState('');

  const deadline = Math.max(retryAt, challenge?.expiresAt ?? 0);
  useEffect(() => {
    if (!deadline) return;
    if (deadline <= Date.now()) {
      setNow(Date.now());
      return;
    }
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time >= deadline) window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 1000);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [deadline]);
  useEffect(() => () => { request.current++; }, []);

  function changeEmail(value: string) {
    request.current++;
    setEmail(value);
    setCode('');
    setChallenge(null);
    setSimulatedCode('');
    setSending(false);
    setRetryAt(0);
    setError('');
  }

  async function send() {
    if (sending || Date.now() < retryAt) return;
    const id = ++request.current;
    setSending(true);
    setError('');
    try {
      const result = await api.sendVerification({ email: email.trim(), purpose });
      if (id !== request.current) return;
      const time = Date.now();
      setNow(time);
      setRetryAt(time + result.resend_after * 1000);
      setChallenge({ id: result.challenge_id, expiresAt: time + result.expires_in * 1000 });
      setCode('');
      if (import.meta.env.DEV && api.isTestAdapter) {
        setSimulatedCode((api as TestAdapter).getLastVerificationCode(email.trim()) ?? '');
      }
    } catch (cause) {
      if (id !== request.current) return;
      setError(getFriendlyErrorMessage(cause));
      if (cause instanceof ApiError && cause.status === 429 && cause.retryAfter) {
        const delay = cause.retryAfter;
        const time = Date.now();
        const end = /^\d+$/.test(delay) ? time + Number(delay) * 1000 : Date.parse(delay);
        if (Number.isFinite(end) && end > time) {
          setNow(time);
          setRetryAt(end);
        }
      }
    } finally {
      if (id === request.current) setSending(false);
    }
  }

  return {
    email, changeEmail, code, setCode, challenge, sending, send, error,
    simulatedCode, expired: Boolean(challenge && now >= challenge.expiresAt),
    countdown: Math.max(0, Math.ceil((retryAt - now) / 1000)),
  };
}

export function EmailVerificationFields({ verification: v, purpose, busy, clearError }: {
  verification: ReturnType<typeof useEmailVerification>;
  purpose: Purpose;
  busy: boolean;
  clearError: () => void;
}) {
  const emailInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="sp-field">
        <label htmlFor="verify-email" className="sp-label">邮箱</label>
        <div className="sp-input-group">
          <input id="verify-email" ref={emailInput} className="sp-input" type="email" required
            autoComplete="email" inputMode="email" placeholder="you@example.com" value={v.email}
            disabled={busy} onChange={(e) => { clearError(); v.changeEmail(e.target.value); }} />
          <button type="button" className="sp-btn" disabled={busy || v.sending || v.countdown > 0 || !v.email.trim()}
            onClick={() => {
              if (!emailInput.current?.reportValidity()) return;
              clearError();
              void v.send();
            }}>
            {v.sending ? '请求中…' : v.countdown ? `${v.countdown} 秒后重发` : v.challenge ? '重新发送' : '发送验证码'}
          </button>
        </div>
        {v.error && <div className="sp-error-text" role="alert">{v.error}</div>}
        {v.challenge && (
          <p className="sp-help" role="status">
            {v.expired ? '验证码已过期，请重新发送。' :
              `请求已受理。${purpose === 'password_reset' ? '如果该邮箱已注册，' : ''}请查看 ${v.email.trim()} 的收件箱和垃圾邮件，填写最新验证码。`}
          </p>
        )}
        {import.meta.env.DEV && v.simulatedCode && !v.expired && (
          <div className="sp-banner sp-banner--warning" role="status">
            [测试适配器模拟验证码] <strong className="sp-mono">{v.simulatedCode}</strong>
          </div>
        )}
      </div>
      <div className="sp-field">
        <label htmlFor="verify-code" className="sp-label">{purpose === 'register' ? '6 位邮箱验证码' : '6 位验证码'}</label>
        <input id="verify-code" type="text" className="sp-input sp-mono" inputMode="numeric" autoComplete="one-time-code"
          pattern="[0-9]{6}" maxLength={6} placeholder="6 位数字" required disabled={busy || v.sending || !v.challenge || v.expired}
          value={v.expired ? '' : v.code} onChange={(e) => { clearError(); v.setCode(e.target.value); }} />
      </div>
    </>
  );
}
