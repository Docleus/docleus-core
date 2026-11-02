import { useSyncExternalStore } from "react";
import { MAIN_BRANCH } from "@docleus/sdk";

const NAVIGATE = "docleus:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE, onChange);
  };
}

export function navigate(
  path: string,
  options: { replace?: boolean } = {},
): void {
  if (options.replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATE));
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

/** The current query string, parsed. */
export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => location.search);
  return new URLSearchParams(search);
}

/**
 * `value` when it is a path on this origin, else `/`: a `return` parameter
 * must not send the user to another site after signing in.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

/** `href` with `params` appended to its query string. */
export function withQuery(
  href: string,
  params: Readonly<Record<string, string>>,
): string {
  const query = new URLSearchParams(params).toString();
  if (query === "") return href;
  return `${href}${href.includes("?") ? "&" : "?"}${query}`;
}

/**
 * Matches `path` against `pattern` (`/orgs/:orgId`, with a trailing `/*`
 * for the rest) and returns the decoded params, or undefined.
 */
export function matchPath(
  pattern: string,
  path: string,
): Record<string, string> | undefined {
  const isPrefix = pattern.endsWith("/*");
  const want = (isPrefix ? pattern.slice(0, -2) : pattern)
    .split("/")
    .filter(Boolean);
  const have = path.split("/").filter(Boolean);
  if (isPrefix ? have.length < want.length : have.length !== want.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [i, segment] of want.entries()) {
    const actual = have[i] ?? "";
    if (segment.startsWith(":")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(actual);
      } catch {
        return undefined;
      }
    } else if (segment !== actual) {
      return undefined;
    }
  }
  if (isPrefix) params["*"] = have.slice(want.length).join("/");
  return params;
}

/** The branch named by a `?branch=` query string, `main` when there is none. */
export function branchOf(search: string): string {
  return new URLSearchParams(search).get("branch") || MAIN_BRANCH;
}

/** The branch the current space route is shown at. */
export function useBranch(): string {
  return branchOf(useSyncExternalStore(subscribe, () => location.search));
}

/** `href` with `?branch=` for `branch`; unchanged for `main`. */
export function withBranch(href: string, branch: string): string {
  return branch === MAIN_BRANCH ? href : withQuery(href, { branch });
}

/** `path` and `search` with the branch parameter set to `branch` (dropped for `main`). */
export function switchBranch(
  path: string,
  search: string,
  branch: string,
): string {
  const params = new URLSearchParams(search);
  if (branch === MAIN_BRANCH) params.delete("branch");
  else params.set("branch", branch);
  const query = params.toString();
  return query === "" ? path : `${path}?${query}`;
}

/**
 * `path` with the query of `search` changed: `null` removes a parameter.
 * Parameters keep their order; new ones go last.
 */
export function withParams(
  path: string,
  search: string,
  changes: Readonly<Record<string, string | null>>,
): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query === "" ? path : `${path}?${query}`;
}

/** Changes the current URL's query; see {@link withParams}. */
export function setParams(
  changes: Readonly<Record<string, string | null>>,
  options: { replace?: boolean } = {},
): void {
  navigate(withParams(location.pathname, location.search, changes), options);
}
