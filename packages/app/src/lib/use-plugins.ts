import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { useHost } from "./host.tsx";
import type { EditorEntry } from "./plugin-loader.ts";

export interface LoadedPlugins {
  readonly isReady: boolean;
  readonly error: unknown;
  reload(): void;
}

/**
 * Loads the editor entries listed at `url` (a `{ editors }` frontend
 * endpoint) before rendering anything that shows plugin UI, and swaps them
 * when `url` changes or `reload` is called. `undefined` leaves the loaded
 * plugins as they are, for a view whose parent loads them.
 */
export function usePlugins(url: string | undefined): LoadedPlugins {
  const { loader } = useHost();
  const [loaded, setLoaded] = useState<string | undefined>();
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  const key = `${url}#${generation}`;
  useEffect(() => {
    if (url === undefined) return;
    let isCurrent = true;
    setError(undefined);
    api<{ editors: EditorEntry[] }>("GET", url)
      .then((result) => loader.apply(result.editors))
      .then(
        () => isCurrent && setLoaded(key),
        (cause: unknown) => isCurrent && setError(cause),
      );
    return () => {
      isCurrent = false;
    };
  }, [url, key, loader]);
  return {
    isReady: url === undefined || loaded === key,
    error,
    reload: () => setGeneration((n) => n + 1),
  };
}
