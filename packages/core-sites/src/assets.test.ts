import { parseManifest } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import {
  filesSha256,
  pluginAssetDir,
  siteBrowserRoot,
  underRoot,
} from "./assets.ts";
import { canonicalJson } from "./rows.ts";

function manifest(entries: Record<string, string>, islands = {}) {
  return parseManifest({
    name: "@acme/x",
    version: "1.0.0",
    engines: { docleus: "*" },
    entries,
    islands,
  });
}

describe("siteBrowserRoot", () => {
  it("is the common directory of the site entry and island modules", () => {
    expect(
      siteBrowserRoot(
        manifest(
          { site: "./dist/site/index.js" },
          { "acme.a": "dist/site/islands/a.js" },
        ),
      ),
    ).toBe("dist/site");
    expect(
      siteBrowserRoot(
        manifest({ site: "dist/site/index.js" }, { b: "dist/b.js" }),
      ),
    ).toBe("dist");
    expect(siteBrowserRoot(manifest({ site: "index.js" }))).toBe("");
    expect(siteBrowserRoot(manifest({ server: "server.js" }))).toBeUndefined();
  });

  it("rejects files outside the plugin directory", () => {
    expect(() => siteBrowserRoot(manifest({ site: "../x.js" }))).toThrow(
      expect.objectContaining({ code: "sites/invalid-plugin-file" }),
    );
  });
});

describe("plugin asset paths", () => {
  it("drops the scope marker and keeps files under the root", () => {
    expect(pluginAssetDir(manifest({ site: "a.js" }))).toBe(
      "_assets/plugins/acme-x@1.0.0/",
    );
    expect(underRoot("dist/site", "./dist/site/a.js")).toBe("a.js");
    expect(underRoot("dist/site", "dist/server/a.js")).toBeUndefined();
    expect(underRoot("", "../a.js")).toBeUndefined();
  });
});

describe("hashing", () => {
  it("hashes file sets independently of insertion order", () => {
    const a = new Map([
      ["x", new Uint8Array([1])],
      ["y", new Uint8Array([2])],
    ]);
    const b = new Map([...a].toReversed());
    expect(filesSha256(a)).toBe(filesSha256(b));
    expect(filesSha256(a)).not.toBe(
      filesSha256(new Map([["x", new Uint8Array([1, 2])]])),
    );
  });

  it("serializes JSON with sorted keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ f: 1, e: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[{"e":2,"f":1}]},"b":1}',
    );
  });
});
