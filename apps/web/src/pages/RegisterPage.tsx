import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { getFriendlyErrorMessage } from '../api/errors';
import { AuthLayout } from '../components/AuthLayout';
import { useAuth } from '../context/AuthContext';
import { countUnicodeChars } from '../lib/document';
import { resolveSafeRedirectPath } from '../lib/extensionPair';
import { EmailVerificationFields, useEmailVerification } from '../components/EmailVerification';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTarget = resolveSafeRedirectPath(
    (location.state as { from?: unknown } | null)?.from,
    '/inbox',
  );

  const verification = useEmailVerification('register');
  const [inviteCode, setInviteCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const { challenge, email, code } = verification;
    if (submitting || verification.sending) return;
    if (!challenge || Date.now() >= challenge.expiresAt) {
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
        challenge_id: challenge.id,
        verification_code: code.trim(),
        invite_code: inviteCode.trim(),
      });
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Spark 邀请内测注册"
      subtitle="一码一人，需先验证邮箱并兑换有效邀请码。"
      messages={error && <div className="sp-banner sp-banner--error" role="alert">{error}</div>}
      footer={
        <>
          <Link to="/login" state={{ from: redirectTarget }}>已有账号？去登录</Link>
          <Link to="/reset-password">忘记密码</Link>
        </>
      }
    >
        <form onSubmit={(e) => void handleSubmit(e)} className="sp-auth-form">
          <EmailVerificationFields verification={verification} purpose="register" busy={submitting} clearError={() => setError(null)} />
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

          <button type="submit" className="sp-btn sp-btn--primary sp-btn--block" disabled={submitting || verification.sending || !verification.challenge || verification.expired}>
            {submitting ? '正在创建账号…' : '验证并注册'}
          </button>
        </form>
    </AuthLayout>
  );
}
