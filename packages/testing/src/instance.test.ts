import { describe, expect, it } from "vitest";
import { createTestInstance } from "./instance.ts";

describe("createTestInstance", () => {
  it("provides a working in-memory storage service", async () => {
    const instance = await createTestInstance();
    try {
      expect(instance.ctx.get("storage")).toBeDefined();
    } finally {
      await instance.dispose();
    }
  });

  it("disposes storage on dispose, leaving no registered service", async () => {
    const instance = await createTestInstance();
    await instance.dispose();
    expect(instance.ctx.get("storage")).toBeUndefined();
  });
});
