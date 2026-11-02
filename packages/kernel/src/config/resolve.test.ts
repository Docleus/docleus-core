import { describe, expect, it } from "vitest";
import { DocleusError } from "../errors.ts";
import {
  applyPatch,
  dumpConfig,
  parseBundle,
  parsePatch,
  composeConfig,
} from "./resolve.ts";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof DocleusError ? error.code : String(error);
  }
  return undefined;
};

const bundle = parseBundle(
  "bundle",
  `
- id: http
  plugin: "@docleus/core-http"
  config: { port: 3000 }
- id: blocks
  plugin: "@docleus/plugin-blocks-commonmark"
`,
);

describe("composeConfig", () => {
  it("returns the bundle unchanged when no patch is given", () => {
    expect(composeConfig({ bundle })).toEqual(bundle);
  });

  it("merges a patch row into an existing row by id, replacing config wholesale", () => {
    const patch = parsePatch(
      "profile",
      "- { id: http, config: { host: 0.0.0.0 } }",
    );
    const rows = composeConfig({ bundle, profile: patch });
    expect(rows[0]).toEqual({
      id: "http",
      plugin: "@docleus/core-http",
      config: { host: "0.0.0.0" },
    });
  });

  it("disables a row with a minimal patch", () => {
    const patch = parsePatch("deployment", "- { id: blocks, disabled: true }");
    expect(composeConfig({ bundle, deployment: patch })[1]).toMatchObject({
      disabled: true,
    });
  });

  it("appends a row that does not exist yet", () => {
    const patch = parsePatch(
      "profile",
      "- { id: mermaid, plugin: '@docleus/plugin-mermaid' }",
    );
    const rows = composeConfig({ bundle, profile: patch });
    expect(rows.map((row) => row.id)).toEqual(["http", "blocks", "mermaid"]);
  });

  it("applies layers in order: profile, deployment, then overlays", () => {
    const rows = composeConfig({
      bundle,
      profile: parsePatch("p", "- { id: http, config: { port: 1 } }"),
      deployment: parsePatch("d", "- { id: http, config: { port: 2 } }"),
      overlays: [
        parsePatch("o1", "- { id: http, config: { port: 3 } }"),
        parsePatch("o2", "- { id: http, config: { port: 4 } }"),
      ],
    });
    expect(rows[0]?.config).toEqual({ port: 4 });
  });

  it("lets a later patch configure a row appended by an earlier patch", () => {
    const rows = composeConfig({
      bundle,
      profile: parsePatch("p", "- { id: extra, plugin: x }"),
      deployment: parsePatch("d", "- { id: extra, config: { on: true } }"),
    });
    expect(rows[2]).toEqual({ id: "extra", plugin: "x", config: { on: true } });
  });

  it("does not mutate its inputs", () => {
    const before = structuredClone(bundle);
    applyPatch(bundle, parsePatch("p", "- { id: http, disabled: true }"));
    expect(bundle).toEqual(before);
  });
});

describe("errors", () => {
  it("rejects an append without a plugin", () => {
    const patch = parsePatch("profile", "- { id: ghost, disabled: true }");
    expect(codeOf(() => composeConfig({ bundle, profile: patch }))).toBe(
      "config/missing-plugin",
    );
  });

  it("rejects duplicate ids inside one layer", () => {
    expect(
      codeOf(() =>
        parseBundle("b", "- { id: a, plugin: x }\n- { id: a, plugin: y }"),
      ),
    ).toBe("config/duplicate-id");
  });

  it("rejects malformed YAML and unknown fields", () => {
    expect(codeOf(() => parseBundle("b", "- [unclosed"))).toBe(
      "config/invalid-yaml",
    );
    expect(
      codeOf(() => parseBundle("b", "- { id: a, plugin: x, typo: 1 }")),
    ).toBe("config/invalid-layer");
  });

  it("treats an empty file as an empty layer", () => {
    expect(parsePatch("empty", "")).toEqual([]);
  });
});

describe("dumpConfig", () => {
  it("prints the resolved rows as YAML that parses back to the same rows", () => {
    const rows = composeConfig({
      bundle,
      profile: parsePatch("p", "- { id: http, config: { port: 8080 } }"),
    });
    expect(dumpConfig(rows)).toBe(
      [
        "- id: http",
        '  plugin: "@docleus/core-http"',
        "  config:",
        "    port: 8080",
        "- id: blocks",
        '  plugin: "@docleus/plugin-blocks-commonmark"',
        "",
      ].join("\n"),
    );
    expect(parseBundle("dump", dumpConfig(rows))).toEqual(rows);
  });
});
