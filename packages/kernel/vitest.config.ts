import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "vendor/*/tests/**/*.spec.ts",
    ],
    exclude: ["vendor/cordis/tests/decorator.spec.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
