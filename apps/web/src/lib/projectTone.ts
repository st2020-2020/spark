// Each project gets a stable washi-tape tone (1–6) from its id, so the same project
// reads as the same color everywhere: sidebar, project list, note tags and detail header.
// Purely presentational — nothing is stored.

export type ProjectTone = 1 | 2 | 3 | 4 | 5 | 6;

export function projectTone(projectId: string): ProjectTone {
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = (hash * 31 + projectId.charCodeAt(i)) | 0;
  }
  return ((Math.abs(hash) % 6) + 1) as ProjectTone;
}

export function projectToneClass(projectId: string): string {
  return `sp-tone-${projectTone(projectId)}`;
}
