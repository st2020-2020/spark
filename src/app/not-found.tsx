import Link from "next/link";
import { SearchX } from "lucide-react";

export default function NotFound() {
  return (
    <main id="main-content" className="error-page">
      <SearchX size={42} />
      <h1>这条记录不在这里了</h1>
      <p>链接可能有误，或记录已被删除。</p>
      <Link className="button button-primary" href="/">
        返回收件箱
      </Link>
    </main>
  );
}
