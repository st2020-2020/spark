import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getFriendlyErrorMessage } from '../api/errors';
import { AuthLayout } from '../components/AuthLayout';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { countUnicodeChars } from '../lib/document';
import { EmailVerificationFields, useEmailVerification } from '../components/EmailVerification';

export function ResetPasswordPage() {
  const api = useApi();
  const { pushToast } = useToast();
  const navigate = useNavigate();

  const verification = useEmailVerification('password_reset');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const { challenge, email, code } = verification;
    if (submitting || verification.sending) return;
    if (!challenge || Date.now() >= challenge.expiresAt) {
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
        challenge_id: challenge.id,
        verification_code: code.trim(),
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

  return (
    <AuthLayout
      title="重置密码"
      subtitle="验证邮箱后重置密码，成功后将撤销所有已登录设备会话。"
      messages={error && <div className="sp-banner sp-banner--error" role="alert">{error}</div>}
      footer={
        <>
          <Link to="/login">返回登录</Link>
          <Link to="/register">注册账号</Link>
        </>
      }
    >
        <form onSubmit={(e) => void handleSubmit(e)} className="sp-auth-form">
          <EmailVerificationFields verification={verification} purpose="password_reset" busy={submitting} clearError={() => setError(null)} />
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

          <button type="submit" className="sp-btn sp-btn--primary sp-btn--block" disabled={submitting || verification.sending || !verification.challenge || verification.expired}>
            {submitting ? '正在重置…' : '确认重置密码'}
          </button>
        </form>
    </AuthLayout>
  );
}
