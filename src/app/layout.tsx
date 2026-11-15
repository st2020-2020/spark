import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Spark · 随手记，慢慢想", template: "%s | Spark" },
  description: "随手记录文字、链接和图片，自动整理摘要与标签。",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a href="#main-content" className="skip-link">
          跳到主要内容
        </a>
        {children}
      </body>
    </html>
  );
}
