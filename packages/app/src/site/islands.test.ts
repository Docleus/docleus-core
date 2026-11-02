import { ISLAND_SCRIPT_ID as SDK_ISLAND_SCRIPT_ID } from "@docleus/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ISLAND_SCRIPT_ID, mountIslands, startIslands } from "./islands.ts";

function page(options: {
  base?: string;
  islands?: unknown;
  body: string;
}): void {
  document.head.innerHTML = options.base ? `<base href="${options.base}">` : "";
  const script =
    options.islands === undefined
      ? ""
      : `<script type="application/json" id="${ISLAND_SCRIPT_ID}">${JSON.stringify(options.islands)}</script>`;
  document.body.innerHTML = `${options.body}${script}`;
}

function fakeModules(modules: Record<string, unknown>) {
  const imported: string[] = [];
  const importModule = vi.fn(async (url: string) => {
    imported.push(url);
    if (!Object.hasOwn(modules, url)) throw new Error(`404 ${url}`);
    return modules[url];
  });
  return { imported, importModule };
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("mountIslands", () => {
  it("uses the SDK's island script id", () => {
    expect(ISLAND_SCRIPT_ID).toBe(SDK_ISLAND_SCRIPT_ID);
  });

  it("mounts each island with its block's props", async () => {
    page({
      base: "https://docs.example/guide/",
      islands: {
        modules: { "acme.tabs": "../_assets/plugins/acme@1.0.0/tabs.js" },
        props: { b1: { tabs: ["a", "b"] } },
      },
      body: `<div data-island="acme.tabs" data-block="b1"></div><div data-island="acme.tabs" data-block="b2"></div>`,
    });
    const mount = vi.fn();
    const { importModule } = fakeModules({
      "https://docs.example/_assets/plugins/acme@1.0.0/tabs.js": { mount },
    });

    await mountIslands(document, importModule);

    const [first, second] = document.querySelectorAll("[data-island]");
    expect(mount).toHaveBeenCalledTimes(2);
    expect(mount).toHaveBeenNthCalledWith(1, first, { tabs: ["a", "b"] });
    expect(mount).toHaveBeenNthCalledWith(2, second, undefined);
  });

  it("imports each block type's module once", async () => {
    page({
      islands: {
        modules: { "acme.a": "./a.js", "acme.b": "./b.js", "acme.c": "./c.js" },
        props: {},
      },
      body: `<div data-island="acme.a" data-block="1"></div><div data-island="acme.b" data-block="2"></div><div data-island="acme.a" data-block="3"></div>`,
    });
    const mount = vi.fn();
    const { imported, importModule } = fakeModules({
      "http://localhost:3000/a.js": { mount },
      "http://localhost:3000/b.js": { mount },
    });

    await mountIslands(document, importModule);

    expect(imported).toEqual([
      "http://localhost:3000/a.js",
      "http://localhost:3000/b.js",
    ]);
    expect(mount).toHaveBeenCalledTimes(3);
  });

  it("resolves module URLs against the document base URI", async () => {
    page({
      base: "https://docs.example/sites/acme/docs/",
      islands: { modules: { "acme.a": "_assets/a.js" }, props: {} },
      body: `<div data-island="acme.a" data-block="1"></div>`,
    });
    const { imported, importModule } = fakeModules({});

    await mountIslands(document, importModule);

    expect(imported).toEqual([
      "https://docs.example/sites/acme/docs/_assets/a.js",
    ]);
  });

  it("keeps mounting the other islands when one fails", async () => {
    page({
      islands: {
        modules: {
          "acme.missing": "./missing.js",
          "acme.no-mount": "./no-mount.js",
          "acme.throws": "./throws.js",
          "acme.ok": "./ok.js",
        },
        props: {},
      },
      body: [
        `<div data-island="acme.missing" data-block="1"></div>`,
        `<div data-island="acme.no-mount" data-block="2"></div>`,
        `<div data-island="acme.throws" data-block="3"></div>`,
        `<div data-island="acme.ok" data-block="4"></div>`,
      ].join(""),
    });
    const mount = vi.fn();
    const { importModule } = fakeModules({
      "http://localhost:3000/no-mount.js": {},
      "http://localhost:3000/throws.js": {
        mount() {
          throw new Error("boom");
        },
      },
      "http://localhost:3000/ok.js": { mount },
    });

    await expect(mountIslands(document, importModule)).resolves.toBeUndefined();

    expect(mount).toHaveBeenCalledWith(
      document.querySelector('[data-block="4"]'),
      undefined,
    );
    expect(console.error).toHaveBeenCalledTimes(3);
  });

  it("skips islands whose type has no module", async () => {
    page({
      islands: { modules: {}, props: {} },
      body: `<div data-island="acme.static" data-block="1"></div>`,
    });
    const { importModule } = fakeModules({});
    await mountIslands(document, importModule);
    expect(importModule).not.toHaveBeenCalled();
  });

  it("imports nothing on a page without the island script", async () => {
    page({ body: `<div data-island="acme.a" data-block="1"></div>` });
    const { importModule } = fakeModules({});
    await mountIslands(document, importModule);
    expect(importModule).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports an island script that is not valid JSON", async () => {
    document.body.innerHTML = `<script type="application/json" id="${ISLAND_SCRIPT_ID}">{</script>`;
    const { importModule } = fakeModules({});
    await mountIslands(document, importModule);
    expect(importModule).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe("startIslands", () => {
  it("waits for DOMContentLoaded while the document is loading", async () => {
    page({
      islands: { modules: { "acme.a": "./a.js" }, props: {} },
      body: `<div data-island="acme.a" data-block="1"></div>`,
    });
    const mount = vi.fn();
    const { importModule } = fakeModules({
      "http://localhost:3000/a.js": { mount },
    });
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");

    const started = startIslands(document, importModule);
    await Promise.resolve();
    expect(importModule).not.toHaveBeenCalled();

    document.dispatchEvent(new Event("DOMContentLoaded"));
    await started;
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("mounts at once when the document is parsed", async () => {
    page({
      islands: { modules: { "acme.a": "./a.js" }, props: {} },
      body: `<div data-island="acme.a" data-block="1"></div>`,
    });
    const mount = vi.fn();
    const { importModule } = fakeModules({
      "http://localhost:3000/a.js": { mount },
    });
    await startIslands(document, importModule);
    expect(mount).toHaveBeenCalledTimes(1);
  });
});
