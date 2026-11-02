import { describe, expect, it } from "vitest";
import {
  findExposeConflicts,
  findIslandConflicts,
  findSyntaxConflicts,
  parseManifest,
  satisfiesRange,
} from "./manifest.ts";

const valid = {
  name: "@acme/plugin-x",
  version: "1.2.3",
  engines: { docleus: "^0.0.1" },
  entries: { server: "./dist/server/index.js" },
};

describe("parseManifest", () => {
  it("accepts a minimal manifest and fills list defaults", () => {
    expect(parseManifest(valid)).toEqual({
      ...valid,
      requires: [],
      provides: [],
      syntax: [],
      exposes: {},
      islands: {},
    });
  });

  it("accepts exposed modules", () => {
    const exposes = { "@tiptap/core": "./dist/vendor/tiptap-core.js" };
    expect(parseManifest({ ...valid, exposes }).exposes).toEqual(exposes);
  });

  it.each([
    ["no entries", { ...valid, entries: {} }],
    ["bad version", { ...valid, version: "one" }],
    ["unknown field", { ...valid, extra: true }],
    ["missing engines", { ...valid, engines: undefined }],
    ["an empty exposed path", { ...valid, exposes: { a: "" } }],
  ])("rejects %s", (_label, manifest) => {
    expect(() => parseManifest(manifest)).toThrow();
  });
});

describe("satisfiesRange", () => {
  it.each([
    ["0.0.1", "^0.0.1", true],
    ["0.0.2", "^0.0.1", false],
    ["0.1.0", "^0.0.1", false],
    ["0.0.1", "^0.1", false],
    ["0.1.0", "^0.1", true],
    ["0.1.9", "^0.1", true],
    ["0.2.0", "^0.1", false],
    ["1.4.0", "^1.2", true],
    ["2.0.0", "^1.2", false],
    ["1.1.9", "^1.2", false],
    ["1.2.5", "~1.2.0", true],
    ["1.3.0", "~1.2.0", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["9.9.9", "*", true],
    ["garbage", "^1", false],
    ["0.1.0", "^0.1junk", false],
    ["1.2.3junk", "^1", false],
    ["1.5.0", "~1", true],
    ["2.0.0", "~1", false],
    ["0.5.0", "^0", true],
    ["1.0.0", "^0", false],
    ["0.1.0", ">=0.1.0", true],
    ["0.0.9", ">=0.1.0", false],
    ["0.9.9", "<1.0.0", true],
    ["1.0.0", "<1.0.0", false],
    ["1.0.0", "<=1.0.0", true],
    ["1.0.1", "<=1.0", true],
    ["1.1.0", "<=1.0", false],
    ["1.0.1", ">1.0.0", true],
    ["1.0.0", ">1.0.0", false],
    ["1.0.9", ">1.0", false],
    ["1.1.0", ">1.0", true],
    ["1.2.3", "=1.2.3", true],
    ["0.5.0", ">=0.1.0 <1.0.0", true],
    ["1.0.0", ">=0.1.0 <1.0.0", false],
    ["0.5.0", ">= 0.1.0 < 1.0.0", true],
    ["1.7.2", "1.x", true],
    ["2.0.0", "1.x", false],
    ["1.2.9", "1.2.x", true],
    ["1.3.0", "1.2.X", false],
    ["4.0.0", "x", true],
    ["1.4.0", "1.*", true],
    ["1.4.0", "1", true],
    ["1.2.0", "1.2", true],
    ["1.3.0", "1.2", false],
    ["0.2.1", "^0.1 || ^0.2", true],
    ["0.3.0", "^0.1 || ^0.2", false],
    ["3.0.0", "^1.0.0 || >=3.0.0", true],
    ["1.2.3", "v1.2.3", true],
    ["0.1.0", "", false],
    ["0.1.0", "||", false],
    ["0.1.0", ">=", false],
    ["0.1.0", "1.x.3", false],
    ["0.1.0", "1.2.3.4", false],
    ["0.1.0", "<x", false],
    ["0.1.0-beta.1", ">=0.1.0", false],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});

describe("findSyntaxConflicts", () => {
  it("reports syntax claimed by more than one manifest", () => {
    expect(
      findSyntaxConflicts([
        { name: "a", syntax: ["heading", "directive:note"] },
        { name: "b", syntax: ["directive:note"] },
        { name: "c", syntax: ["table", "directive:note"] },
      ]),
    ).toEqual([{ syntax: "directive:note", plugins: ["a", "b", "c"] }]);
  });

  it("ignores a manifest listing the same syntax twice", () => {
    expect(findSyntaxConflicts([{ name: "a", syntax: ["x", "x"] }])).toEqual(
      [],
    );
  });
});

describe("findExposeConflicts", () => {
  it("reports a specifier exposed by more than one manifest", () => {
    expect(
      findExposeConflicts([
        { name: "a", exposes: { x: "./x.js", y: "./y.js" } },
        { name: "b", exposes: { y: "./other.js" } },
        { name: "c", exposes: {} },
      ]),
    ).toEqual([{ specifier: "y", plugins: ["a", "b"] }]);
  });
});

describe("findIslandConflicts", () => {
  it("reports a block type with an island in more than one manifest", () => {
    expect(
      findIslandConflicts([
        { name: "a", islands: { "acme.x": "./x.js" } },
        { name: "b", islands: { "acme.x": "./y.js", "acme.y": "./y.js" } },
      ]),
    ).toEqual([{ type: "acme.x", plugins: ["a", "b"] }]);
  });
});
