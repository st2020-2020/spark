import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getFriendlyErrorMessage } from '../api/errors';
import { AuthLayout } from '../components/AuthLayout';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { countUnicodeChars } from '../lib/document';
import type { TestAdapter } from '../test-adapter/mockServer';

export function ResetPasswordPage() {
  const api = useApi();
  const { pushToast } = useToast();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
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
      const res = await api.sendVerification({ email: trimmedEmail, purpose: 'password_reset' });
      setChallengeId(res.challenge_id);
      setCountdown(res.resend_after);
      setNotice(
        '如果账号存在，验证码挑战已创建。开发模式下请通过后端开发邮件工具查看验证码；正式环境请查收邮箱。',
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
      setError('请先获取邮箱验证码。');
      return;
    }
    const len = countUnicodeChars(newPassword);
    if (len < 12 || len > 128) {
      setError('新密码长度需在 12 至 128 个字符之间。');
      return;
    }
    setSubmitting(true);
    try {
      await api.resetPassword({
        email: email.trim(),
        challenge_id: challengeId,
        verification_code: verificationCode.trim(),
        new_password: newPassword,
      });
      pushToast({ message: '密码已重置，旧会话已全部失效，请使用新密码登录。' });
      navigate('/login', { replace: true });
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const showSimulatedCode = api.isTestAdapter && simulatedCode;

  return (
    <AuthLayout
      title="重置密码"
      subtitle="验证邮箱后重置密码，成功后将撤销所有已登录设备会话。"
      messages={
        (error || notice || showSimulatedCode) && (
          <>
            {error && (
              <div className="sp-banner sp-banner--error" role="alert">
                <span>{error}</span>
              </div>
            )}
            {notice && (
              <div className="sp-banner sp-banner--info" role="status">
                <span>{notice}</span>
              </div>
            )}
            {showSimulatedCode && (
              <div className="sp-banner sp-banner--warning" role="status">
                <span>
                  [测试适配器模拟验证码]：<strong className="sp-mono">{simulatedCode}</strong>
                </span>
              </div>
            )}
          </>
        )
      }
      footer={
        <>
          <Link to="/login">返回登录</Link>
          <Link to="/register">注册账号</Link>
        </>
      }
    >
        <form onSubmit={(e) => void handleSubmit(e)} className="sp-auth-form">
          <div className="sp-field">
            <label htmlFor="reset-email" className="sp-label">
              邮箱
            </label>
            <div className="sp-input-group">
              <input
                id="reset-email"
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                className="sp-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button
                type="button"
                className="sp-btn"
                disabled={sendingCode || countdown > 0 || !email.trim()}
                onClick={() => void handleSendCode()}
              >
                {countdown > 0 ? `${countdown}s 后重发` : sendingCode ? '请求中…' : '发送验证码'}
              </button>
            </div>
          </div>

          <div className="sp-field">
            <label htmlFor="reset-code" className="sp-label">
              6 位验证码
            </label>
            <input
              id="reset-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              className="sp-input sp-mono"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
            />
          </div>

          <div className="sp-field">
            <label htmlFor="reset-password" className="sp-label">
              新密码（12 至 128 位）
            </label>
            <input
              id="reset-password"
              type="password"
              minLength={12}
              maxLength={128}
              required
              autoComplete="new-password"
              className="sp-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="sp-btn sp-btn--primary sp-btn--block" disabled={submitting}>
            {submitting ? '正在重置…' : '确认重置密码'}
          </button>
        </form>
    </AuthLayout>
  );
}
