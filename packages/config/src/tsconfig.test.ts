import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const base = JSON.parse(
  readFileSync(new URL("../tsconfig.base.json", import.meta.url), "utf8"),
) as { compilerOptions: Record<string, unknown> };

describe("tsconfig.base.json", () => {
  it("enables the strictness flags required by AGENTS.md", () => {
    expect(base.compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      verbatimModuleSyntax: true,
    });
  });

  it("leaves exactOptionalPropertyTypes off", () => {
    expect(base.compilerOptions.exactOptionalPropertyTypes).toBeUndefined();
  });
});
