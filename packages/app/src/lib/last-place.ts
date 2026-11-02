const KEY = "docleus.last-place";

/** Remembers the organization page the user is on, to come back to after sign-in. */
export function rememberPlace(path: string): void {
  if (!path.startsWith("/orgs/")) return;
  try {
    localStorage.setItem(KEY, path);
  } catch {
    // Storage can be unavailable (private mode, quota); landing falls back.
  }
}

/** The path a sign-in lands on: the last place in an organization the user still has, else their only organization. */
export function landingPath(orgIds: readonly string[]): string | undefined {
  let last: string | null = null;
  try {
    last = localStorage.getItem(KEY);
  } catch {
    last = null;
  }
  const lastOrg = last?.split("/")[2];
  if (last && lastOrg !== undefined && orgIds.includes(lastOrg)) return last;
  return orgIds.length === 1 ? `/orgs/${orgIds[0]}` : undefined;
}

/** The return path after a sign-in: the landing rather than the organization list. */
export const LANDING = "/?landing=1";
