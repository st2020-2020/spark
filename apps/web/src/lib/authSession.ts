export interface AuthSessionSnapshot {
  generation: number;
  userId: string | null;
}

let currentGeneration = 0;
let currentUserId: string | null = null;

export function captureAuthSession(): AuthSessionSnapshot {
  return {
    generation: currentGeneration,
    userId: currentUserId,
  };
}

export function isSameAuthSession(snapshot: AuthSessionSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return snapshot.generation === currentGeneration && snapshot.userId === currentUserId;
}

export function advanceAuthSession(userId: string | null): AuthSessionSnapshot {
  currentGeneration += 1;
  currentUserId = userId;
  return captureAuthSession();
}
