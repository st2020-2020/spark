import { Sparkles } from "lucide-react";

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Sparkles size={23} strokeWidth={1.7} aria-hidden="true" />
      </span>
      <span className="brand-name">
        spark<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
