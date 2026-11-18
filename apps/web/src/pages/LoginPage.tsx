import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';

export function LoginPage() {
  const api = useApi();
  const { login, sessionError } = useAuth();
  const navigate = useNavigate();

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
      navigate('/inbox', { replace: true });
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sp-auth-page">
      {import.meta.env.DEV && api.isTestAdapter && (
        <div
          className="sp-banner sp-banner--warning"
          style={{ maxWidth: 400, width: '100%', marginBottom: 12 }}
        >
          <span>
            本地测试适配器模式（仅内存模拟）。示例管理员：
            <span className="sp-mono">admin@spark.local</span> /{' '}
            <span className="sp-mono">SparkAdmin1234!</span>
          </span>
        </div>
      )}

      <div className="sp-auth-card">
        <div className="sp-brand" style={{ padding: '0 0 10px' }}>
          <span className="sp-brand-mark" aria-hidden="true">S</span>
          <span>Spark</span>
        </div>
        <h1 className="sp-page-title" style={{ fontSize: 18, marginBottom: 4 }}>
          登录你的空间
        </h1>
        <p className="sp-help" style={{ marginTop: 0, marginBottom: 18 }}>
          随时记录想法、网址与阅读线索
        </p>

        {sessionError && (
          <div className="sp-banner sp-banner--warning" style={{ marginBottom: 12 }} role="alert">
            <span>{sessionError}</span>
          </div>
        )}

        {error && (
          <div className="sp-banner sp-banner--error" style={{ marginBottom: 12 }} role="alert">
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="sp-stack" style={{ gap: 14 }}>
          <div className="sp-field">
            <label htmlFor="login-email" className="sp-label">
              邮箱
            </label>
            <input
              id="login-email"
              type="email"
              required
              autoComplete="email"
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
            {submitting ? '正在登录…' : '登录'}
          </button>
        </form>

        <div className="sp-row-between" style={{ marginTop: 18, fontSize: 13 }}>
          <Link to="/register">使用邀请码注册</Link>
          <Link to="/reset-password">忘记密码</Link>
        </div>
      </div>
    </div>
  );
}
