import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { getFriendlyErrorMessage } from '../api/errors';
import { AuthLayout } from '../components/AuthLayout';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { resolveSafeRedirectPath } from '../lib/extensionPair';

export function LoginPage() {
  const api = useApi();
  const { login, sessionError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTarget = resolveSafeRedirectPath(
    (location.state as { from?: unknown } | null)?.from,
    '/inbox',
  );

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email: email.trim(), password });
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="登录你的空间"
      subtitle="随时记录想法、网址与阅读线索"
      devNotice={
        import.meta.env.DEV &&
        api.isTestAdapter && (
          <div className="sp-banner sp-banner--warning">
            <span>
              本地测试适配器模式（仅内存模拟）。示例管理员：
              <span className="sp-mono">admin@spark.local</span> /{' '}
              <span className="sp-mono">SparkAdmin1234!</span>
            </span>
          </div>
        )
      }
      messages={
        (sessionError || error) && (
          <>
            {sessionError && (
              <div className="sp-banner sp-banner--warning" role="alert">
                <span>{sessionError}</span>
              </div>
            )}
            {error && (
              <div className="sp-banner sp-banner--error" role="alert">
                <span>{error}</span>
              </div>
            )}
          </>
        )
      }
      footer={
        <>
          <Link to="/register" state={{ from: redirectTarget }}>使用邀请码注册</Link>
          <Link to="/reset-password">忘记密码</Link>
        </>
      }
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="sp-auth-form">
        <div className="sp-field">
          <label htmlFor="login-email" className="sp-label">
            邮箱
          </label>
          <input
            id="login-email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            className="sp-input"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="sp-field">
          <label htmlFor="login-password" className="sp-label">
            密码
          </label>
          <div className="sp-password-wrap">
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              required
              minLength={1}
              maxLength={128}
              autoComplete="current-password"
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
              {showPassword ? <EyeOff size={17} strokeWidth={2} /> : <Eye size={17} strokeWidth={2} />}
            </button>
          </div>
        </div>

        <button type="submit" className="sp-btn sp-btn--primary sp-btn--block" disabled={submitting}>
          {submitting ? '正在登录…' : '登录'}
        </button>
      </form>
    </AuthLayout>
  );
}
