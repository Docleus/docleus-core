import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";

const config = (name: string) =>
  fileURLToPath(new URL(`../../server/tests/config/${name}`, import.meta.url));

function exec(args: string[]) {
  let out = "";
  let err = "";
  const code = run(args, {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
  });
  return { code, out, err };
}

describe("docleus --dump-config", () => {
  it("prints the resolved config", () => {
    const { code, out, err } = exec([
      "--dump-config",
      "--bundle",
      config("bundle.yaml"),
      "--profile",
      config("profile.yaml"),
      "--patch",
      config("overlay.yaml"),
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("theme: dark");
  });

  it("fails with exit code 2 and usage when --bundle is missing", () => {
    const { code, err } = exec(["--dump-config"]);
    expect(code).toBe(2);
    expect(err).toContain("--bundle is required");
  });

  it("fails with exit code 2 on an unknown flag", () => {
    expect(exec(["--nope"]).code).toBe(2);
  });

  it("fails with exit code 1 and a message when the bundle is unreadable", () => {
    const { code, err } = exec([
      "--dump-config",
      "--bundle",
      config("absent.yaml"),
    ]);
    expect(code).toBe(1);
    expect(err).toContain("absent.yaml");
  });
});
