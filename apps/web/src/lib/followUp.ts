import type {
  Collection,
  CollectionSummary,
  Project,
  ProjectAssociation,
} from '../api/types';
import { derivePlainText } from './document';

export interface FollowUpSource {
  id: string;
  displayTitle: string;
  excerpt?: string;
  projects: ProjectAssociation[];
}

export function followUpDraftScope(sourceId: string): string {
  return `follow-up:${sourceId}`;
}

export function isAttributedProjectDecision(decision: ProjectAssociation['decision']): boolean {
  return decision === 'manual' || decision === 'confirmed' || decision === 'auto';
}

export function toFollowUpSourceFromSummary(collection: CollectionSummary): FollowUpSource {
  return {
    id: collection.id,
    displayTitle: collection.display_title,
    excerpt: collection.excerpt,
    projects: collection.projects,
  };
}

export function toFollowUpSourceFromCollection(collection: Collection): FollowUpSource {
  const plain = derivePlainText(collection.document).trim();
  return {
    id: collection.id,
    displayTitle: collection.display_title,
    excerpt: plain.slice(0, 180) || collection.original_url || collection.intent || undefined,
    projects: collection.projects,
  };
}

export function selectInitialFollowUpProjects(
  sourceProjects: ProjectAssociation[],
  knownProjects?: Project[],
): { projectIds: string[]; names: Record<string, string> } {
  const knownIds = knownProjects ? new Set(knownProjects.map((p) => p.id)) : null;
  const projectIds: string[] = [];
  const names: Record<string, string> = {};
  const seen = new Set<string>();

  for (const assoc of sourceProjects) {
    if (!isAttributedProjectDecision(assoc.decision)) continue;
    if (knownIds && !knownIds.has(assoc.project_id)) continue;
    if (seen.has(assoc.project_id)) continue;
    seen.add(assoc.project_id);
    projectIds.push(assoc.project_id);
    names[assoc.project_id] = assoc.name;
  }

  return { projectIds, names };
}

export function followUpCountLabel(count?: number): string | null {
  if (!count || count <= 0) return null;
  return `同一线索还有 ${count} 条`;
}
