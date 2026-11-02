import { describe, expect, it } from "vitest";
import { initials, plural, slugify } from "./format.ts";

describe("format", () => {
  it("makes initials from names and emails", () => {
    expect(initials("Mei Lin")).toBe("ML");
    expect(initials("ada@example.com")).toBe("AD");
    expect(initials("sam.okafor@x.dev")).toBe("SO");
  });

  it("pluralizes and slugifies", () => {
    expect(plural(1, "page")).toBe("1 page");
    expect(plural(2, "page")).toBe("2 pages");
    expect(slugify("Platform handbook!")).toBe("platform-handbook");
  });
});
