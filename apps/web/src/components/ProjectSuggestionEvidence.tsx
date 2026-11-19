import { Quote } from 'lucide-react';
import type { ProjectAssociation } from '../api/types';
import { evidenceSourceLabel } from '../lib/organization';

export function ProjectSuggestionEvidence({
  association,
}: {
  association: ProjectAssociation;
}) {
  const evidence = association.evidence ?? [];
  if (!association.reason && evidence.length === 0) {
    return null;
  }

  return (
    <div className="sp-evidence-wrap">
      {association.reason && (
        <div className="sp-help sp-break-anywhere">
          推荐理由：{association.reason}
        </div>
      )}
      {evidence.length > 0 && (
        <ul className="sp-evidence-list" aria-label="推荐依据摘录">
          {evidence.map((item, idx) => (
            <li key={`${item.source_id}-${idx}`} className="sp-evidence-item">
              <span className="sp-evidence-source">{evidenceSourceLabel(item.source_id)}</span>
              <span className="sp-evidence-quote sp-break-anywhere">
                <Quote size={12} strokeWidth={2} aria-hidden="true" />
                <span>{item.quote}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
