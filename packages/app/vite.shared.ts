import { createRequire } from "node:module";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

/**
 * Modules the host shares with plugin frontends through the import map.
 * Each becomes an entry that re-exports the real module, so the app and
 * every plugin use one copy (one React, one SDK, one set of contexts).
 */
export const SHARED = {
  react: "react",
  "react/jsx-runtime": "react/jsx-runtime",
  "react-dom": "react-dom",
  "react-dom/client": "react-dom/client",
  "@docleus/sdk": "@docleus/sdk",
} as const;

const VIRTUAL = "\0docleus-shared:";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function fileNameOf(specifier: string): string {
  return `vendor/${specifier.replace(/^@/, "").replaceAll("/", "-")}.js`;
}

/**
 * React ships CommonJS, so `export *` would not carry its named exports
 * through the bundler. The shim lists them explicitly.
 */
function shimSource(specifier: string): string {
  if (specifier === "@docleus/sdk") return `export * from "@docleus/sdk";`;
  const names = Object.keys(require(specifier) as object).filter(
    (name) => IDENTIFIER.test(name) && name !== "default",
  );
  return [
    `import * as m from "${specifier}";`,
    `export const { ${names.join(", ")} } = m;`,
    `export default m;`,
  ].join("\n");
}

/** Rolldown inputs that build one `vendor/<name>.js` per shared module. */
export function sharedInputs(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(SHARED).map((specifier) => [
      fileNameOf(specifier).replace(/\.js$/, ""),
      `${VIRTUAL}${specifier}`,
    ]),
  );
}

/** The output file of a shared entry chunk, or undefined for other chunks. */
export function sharedFileName(
  facadeModuleId: string | null | undefined,
): string | undefined {
  return facadeModuleId?.startsWith(VIRTUAL)
    ? fileNameOf(facadeModuleId.slice(VIRTUAL.length))
    : undefined;
}

/**
 * Builds the shared modules and emits `importmap.json`, whose URLs are the
 * output file names behind `prefix` (`/_app/` for the app, `""` for the
 * site runtime, whose map is relative to its build root).
 */
export function sharedModules(prefix: string): Plugin {
  return {
    name: "docleus-shared-modules",
    resolveId(id) {
      return id.startsWith(VIRTUAL) ? id : undefined;
    },
    load(id) {
      return id.startsWith(VIRTUAL)
        ? shimSource(id.slice(VIRTUAL.length))
        : undefined;
    },
    generateBundle(_options, bundle) {
      const imports: Record<string, string> = {};
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.facadeModuleId) continue;
        if (!chunk.facadeModuleId.startsWith(VIRTUAL)) continue;
        imports[chunk.facadeModuleId.slice(VIRTUAL.length)] =
          `${prefix}${chunk.fileName}`;
      }
      this.emitFile({
        type: "asset",
        fileName: "importmap.json",
        source: `${JSON.stringify({ imports }, null, 2)}\n`,
      });
    },
  };
}
