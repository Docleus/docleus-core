import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dumpResolvedConfig } from "../src/index.ts";

const file = (name: string) =>
  fileURLToPath(new URL(`./config/${name}`, import.meta.url));

describe("dumpResolvedConfig", () => {
  it("prints the layered result as the expected YAML", () => {
    const output = dumpResolvedConfig({
      bundle: file("bundle.yaml"),
      profile: file("profile.yaml"),
      deployment: file("deployment.yaml"),
      patches: [file("overlay.yaml")],
    });
    expect(output).toBe(readFileSync(file("expected.yaml"), "utf8"));
  });

  it("treats missing profile and deployment files as empty layers", () => {
    const output = dumpResolvedConfig({
      bundle: file("bundle.yaml"),
      profile: file("absent.yaml"),
      deployment: file("absent.yaml"),
    });
    expect(output).toBe(readFileSync(file("bundle.yaml"), "utf8"));
  });
});
