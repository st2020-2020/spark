import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { countUnicodeChars } from '../lib/document';
import type { TestAdapter } from '../test-adapter/mockServer';

export function RegisterPage() {
  const api = useApi();
  const { register } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [simulatedCode, setSimulatedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const handleSendCode = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('请先填写邮箱地址。');
      return;
    }
    setError(null);
    setNotice(null);
    setSendingCode(true);
    try {
      const res = await api.sendVerification({ email: trimmedEmail, purpose: 'register' });
      setChallengeId(res.challenge_id);
      setCountdown(res.resend_after);
      setNotice(
        '验证码挑战已创建。开发模式下请通过后端开发邮件工具查看 6 位验证码；正式环境请查收邮箱。',
      );
      if (api.isTestAdapter) {
        const testApi = api as TestAdapter;
        setSimulatedCode(testApi.getLastVerificationCode?.(trimmedEmail) ?? null);
      }
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!challengeId) {
      setError('请先获取并填写邮箱验证码。');
      return;
    }
    const pwdLen = countUnicodeChars(password);
    if (pwdLen < 12 || pwdLen > 128) {
      setError('密码长度需在 12 至 128 个字符之间。');
      return;
    }
    setSubmitting(true);
    try {
      await register({
        email: email.trim(),
        password,
        challenge_id: challengeId,
        verification_code: verificationCode.trim(),
        invite_code: inviteCode.trim(),
      });
      navigate('/inbox', { replace: true });
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sp-auth-page">
      <div className="sp-auth-card">
        <div className="sp-brand" style={{ padding: '0 0 10px' }}>
          <span className="sp-brand-mark" aria-hidden="true">S</span>
          <span>Spark</span>
        </div>
        <h1 className="sp-page-title" style={{ fontSize: 18, marginBottom: 4 }}>
          Spark 邀请内测注册
        </h1>
        <p className="sp-help" style={{ marginTop: 0, marginBottom: 18 }}>
          一码一人，需先验证邮箱并兑换有效邀请码。
        </p>

        {error && (
          <div className="sp-banner sp-banner--error" style={{ marginBottom: 12 }} role="alert">
            <span>{error}</span>
          </div>
        )}

        {notice && (
          <div className="sp-banner sp-banner--info" style={{ marginBottom: 12 }} role="status">
            <span>{notice}</span>
          </div>
        )}

        {import.meta.env.DEV && api.isTestAdapter && simulatedCode && (
          <div className="sp-banner sp-banner--warning" style={{ marginBottom: 12 }} role="status">
            <span>
              [测试适配器模拟验证码]（非真实邮件）：<strong className="sp-mono">{simulatedCode}</strong>
              ；可用测试邀请码：<span className="sp-mono">SPARK-TEST-0001</span>
            </span>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="sp-stack" style={{ gap: 14 }}>
          <div className="sp-field">
            <label htmlFor="reg-email" className="sp-label">
              邮箱
            </label>
            <div className="sp-row">
              <input
                id="reg-email"
                type="email"
                required
                autoComplete="email"
                className="sp-input"
                style={{ flex: 1 }}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button
                type="button"
                className="sp-btn"
                style={{ minHeight: 44 }}
                disabled={sendingCode || countdown > 0 || !email.trim()}
                onClick={() => void handleSendCode()}
              >
                {countdown > 0 ? `${countdown}s 后重发` : sendingCode ? '请求中…' : '发送验证码'}
              </button>
            </div>
          </div>

          <div className="sp-field">
            <label htmlFor="reg-code" className="sp-label">
              6 位邮箱验证码
            </label>
            <input
              id="reg-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              className="sp-input sp-mono"
              placeholder="6 位数字"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
            />
          </div>

          <div className="sp-field">
            <label htmlFor="reg-invite" className="sp-label">
              邀请码
            </label>
            <input
              id="reg-invite"
              type="text"
              minLength={12}
              maxLength={64}
              required
              className="sp-input sp-mono"
              placeholder="12 至 64 位邀请码（区分大小写）"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
            />
          </div>

          <div className="sp-field">
            <label htmlFor="reg-password" className="sp-label">
              设置密码（12 至 128 位）
            </label>
            <div className="sp-password-wrap">
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                minLength={12}
                maxLength={128}
                required
                autoComplete="new-password"
                className="sp-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="sp-password-toggle"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff size={16} strokeWidth={2} /> : <Eye size={16} strokeWidth={2} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="sp-btn sp-btn--primary"
            style={{ width: '100%', minHeight: 42 }}
            disabled={submitting}
          >
            {submitting ? '正在创建账号…' : '验证并注册'}
          </button>
        </form>

        <div className="sp-row-between" style={{ marginTop: 18, fontSize: 13 }}>
          <Link to="/login">已有账号？去登录</Link>
          <Link to="/reset-password">忘记密码</Link>
        </div>
      </div>
    </div>
  );
}
