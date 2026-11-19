import type { ReactNode } from 'react';
import { BrandMark } from './Brand';
import { JarScene } from './Illustrations';

/** Shared frame for login, registration and password reset. */
export function AuthLayout({
  title,
  subtitle,
  devNotice,
  messages,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  devNotice?: ReactNode;
  messages?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="sp-auth-page">
      <div className="sp-auth-shell">
        <aside className="sp-auth-aside">
          <div className="sp-auth-brand">
            <BrandMark />
            <span className="sp-brand-word">Spark</span>
          </div>
          <JarScene animated className="sp-auth-art" />
          <p className="sp-auth-tagline">把一闪而过的念头，先装进瓶子里。</p>
          <p className="sp-auth-tagline-sub">记下文字和网址，归到正在做的项目，需要时再找回来。</p>
        </aside>

        <main className="sp-auth-main">
          {devNotice && <div className="sp-auth-dev">{devNotice}</div>}
          <div className="sp-auth-card">
            <div className="sp-auth-head">
              <h1 className="sp-auth-title">{title}</h1>
              <p className="sp-auth-subtitle">{subtitle}</p>
            </div>
            {messages && <div className="sp-auth-messages">{messages}</div>}
            {children}
            <div className="sp-auth-links">{footer}</div>
          </div>
        </main>
      </div>
    </div>
  );
}
