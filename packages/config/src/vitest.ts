import type { ViteUserConfig } from "vitest/config";

export const baseVitestConfig: ViteUserConfig = {
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
};
