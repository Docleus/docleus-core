import type { IslandManifest } from "@docleus/sdk";

/**
 * The SDK's `ISLAND_SCRIPT_ID`. Importing the value would pull the whole SDK
 * into the runtime, which every visitor page loads.
 */
export const ISLAND_SCRIPT_ID = "docleus-islands";

export type IslandImporter = (url: string) => Promise<unknown>;

type Mount = (element: HTMLElement, props: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function report(message: string, cause: unknown): void {
  // Visitor pages run without Cordis, so there is no ctx logger to use.
  // oxlint-disable-next-line no-console -- the browser console is the only log here
  console.error(`[docleus] ${message}`, cause);
}

function readIslandData(document: Document): IslandManifest | undefined {
  const script = document.getElementById(ISLAND_SCRIPT_ID);
  if (!script) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(script.textContent ?? "");
  } catch (cause) {
    report(`#${ISLAND_SCRIPT_ID} is not valid JSON`, cause);
    return undefined;
  }
  if (!isRecord(data) || !isRecord(data.modules)) {
    report(`#${ISLAND_SCRIPT_ID} has no "modules" object`, data);
    return undefined;
  }
  const modules: Record<string, string> = {};
  for (const [type, url] of Object.entries(data.modules)) {
    if (typeof url === "string") modules[type] = url;
  }
  const props = isRecord(data.props) ? data.props : {};
  return { modules, props: props as IslandManifest["props"] };
}

/**
 * Mounts every `[data-island]` element of `document` whose block type has
 * a module in the island script: each module is imported once and its
 * `mount(element, props)` called per element. Never rejects; failures are
 * reported per island so the others still mount.
 */
export async function mountIslands(
  document: Document,
  importModule: IslandImporter,
): Promise<void> {
  const data = readIslandData(document);
  if (!data) return;
  const loaded = new Map<string, Promise<unknown>>();
  const load = (type: string, url: string): Promise<unknown> => {
    let module = loaded.get(type);
    if (!module) {
      module = importModule(new URL(url, document.baseURI).href);
      loaded.set(type, module);
    }
    return module;
  };
  const elements = document.querySelectorAll<HTMLElement>("[data-island]");
  await Promise.all(
    Array.from(elements, async (element) => {
      const type = element.dataset.island ?? "";
      const url = Object.hasOwn(data.modules, type)
        ? data.modules[type]
        : undefined;
      if (url === undefined) return;
      const block = element.dataset.block ?? "";
      const failed = `island "${type}" (block "${block}") failed`;
      try {
        const module = await load(type, url);
        const mount = isRecord(module) ? module.mount : undefined;
        if (typeof mount !== "function") {
          report(failed, `${url} does not export "mount"`);
          return;
        }
        (mount as Mount)(
          element,
          Object.hasOwn(data.props, block) ? data.props[block] : undefined,
        );
      } catch (cause) {
        report(failed, cause);
      }
    }),
  );
}

/** Runs {@link mountIslands} once the document has been parsed. */
export function startIslands(
  document: Document,
  importModule: IslandImporter,
): Promise<void> {
  if (document.readyState !== "loading") {
    return mountIslands(document, importModule);
  }
  return new Promise((resolve) => {
    document.addEventListener(
      "DOMContentLoaded",
      () => resolve(mountIslands(document, importModule)),
      { once: true },
    );
  });
}
