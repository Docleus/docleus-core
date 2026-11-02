import { beforeEach, describe, expect, it } from "vitest";
import { landingPath, rememberPlace } from "./last-place.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("landingPath", () => {
  it("goes back to the last page in an organization the user still has", () => {
    rememberPlace("/orgs/o2/spaces/s1/pages/p1");
    expect(landingPath(["o1", "o2"])).toBe("/orgs/o2/spaces/s1/pages/p1");
  });

  it("goes into the only organization when there is no usable last place", () => {
    rememberPlace("/orgs/gone/spaces/s1");
    expect(landingPath(["o1"])).toBe("/orgs/o1");
  });

  it("stays on the list with several organizations and no last place", () => {
    expect(landingPath(["o1", "o2"])).toBeUndefined();
  });

  it("only remembers organization pages", () => {
    rememberPlace("/settings/users");
    expect(landingPath(["o1", "o2"])).toBeUndefined();
  });
});
