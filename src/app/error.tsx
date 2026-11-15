"use client";
import { Button, Notice } from "@/components/ui";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main-content" className="error-page">
      <h1>暂时无法打开记录</h1>
      <Notice tone="error">请检查本机数据目录是否可写，然后重试。</Notice>
      <Button onClick={reset}>重新加载</Button>
    </main>
  );
}
