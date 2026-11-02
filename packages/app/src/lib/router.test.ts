import { describe, expect, it } from "vitest";
import {
  branchOf,
  matchPath,
  safeReturnPath,
  switchBranch,
  withBranch,
  withParams,
  withQuery,
} from "./router.ts";

describe("matchPath", () => {
  it("matches params and decodes them", () => {
    expect(matchPath("/orgs/:orgId", "/orgs/a%20b")).toEqual({ orgId: "a b" });
    expect(matchPath("/orgs/:orgId", "/orgs/a/b")).toBeUndefined();
    expect(matchPath("/orgs/:orgId", "/spaces/a")).toBeUndefined();
    expect(matchPath("/orgs/:orgId", "/orgs/%E0%A4%A")).toBeUndefined();
  });

  it("matches the rest of the path with /*", () => {
    expect(matchPath("/apps/*", "/apps/board/x")).toEqual({ "*": "board/x" });
    expect(matchPath("/settings/*", "/settings")).toEqual({ "*": "" });
  });
});

describe("safeReturnPath", () => {
  it("keeps paths on this origin", () => {
    expect(safeReturnPath("/orgs/o1?tab=x")).toBe("/orgs/o1?tab=x");
    expect(safeReturnPath("/")).toBe("/");
  });

  it("replaces anything that could leave the origin", () => {
    for (const value of [
      null,
      undefined,
      "",
      "orgs",
      "//evil.test",
      "/\\evil.test",
      "https://evil.test/",
      "javascript:alert(1)",
    ]) {
      expect(safeReturnPath(value)).toBe("/");
    }
  });
});

describe("withQuery", () => {
  it("appends to an href with or without a query", () => {
    expect(withQuery("/start", { return: "/a b" })).toBe(
      "/start?return=%2Fa+b",
    );
    expect(withQuery("/start?x=1", { a: "b" })).toBe("/start?x=1&a=b");
    expect(withQuery("/start", {})).toBe("/start");
  });
});

describe("branches", () => {
  it("reads ?branch= and defaults to main", () => {
    expect(branchOf("")).toBe("main");
    expect(branchOf("?branch=")).toBe("main");
    expect(branchOf("?x=1&branch=cr%2F1")).toBe("cr/1");
  });

  it("adds the branch to links except for main", () => {
    expect(withBranch("/orgs/o1/spaces/s1", "main")).toBe("/orgs/o1/spaces/s1");
    expect(withBranch("/orgs/o1/spaces/s1/pages/p1", "cr/1")).toBe(
      "/orgs/o1/spaces/s1/pages/p1?branch=cr%2F1",
    );
  });

  it("switches the branch and keeps other parameters", () => {
    expect(switchBranch("/p", "?x=1", "cr/2")).toBe("/p?x=1&branch=cr%2F2");
    expect(switchBranch("/p", "?branch=cr%2F2&x=1", "main")).toBe("/p?x=1");
    expect(switchBranch("/p", "?branch=cr%2F2", "main")).toBe("/p");
  });
});

describe("withParams", () => {
  it("sets, replaces and removes parameters in order", () => {
    expect(withParams("/p", "?branch=cr%2F1&edit=1", { edit: null })).toBe(
      "/p?branch=cr%2F1",
    );
    expect(withParams("/p", "", { view: "diff" })).toBe("/p?view=diff");
    expect(withParams("/p", "?a=1", { a: "2", b: "3" })).toBe("/p?a=2&b=3");
    expect(withParams("/p", "?a=1", { a: null })).toBe("/p");
  });
});
