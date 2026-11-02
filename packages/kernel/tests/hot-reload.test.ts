import { describe, expect, it, vi } from "vitest";
import { Context, Service } from "../src/index.ts";

// `on` is typed against `keyof Events`, whose only augmentation lives in
// @docleus/sdk; a second augmentation here would break that typing.
const CUSTOM_EVENT = "custom/event" as never;

class Greeter extends Service {
  constructor(ctx: Context) {
    super(ctx, "greeter");
    ctx.on(CUSTOM_EVENT, () => undefined);
  }
}

class Consumer {
  static inject = ["greeter"];
  constructor(ctx: Context) {
    ctx.on(CUSTOM_EVENT, () => undefined);
  }
}

function listenerCount(root: Context, name: string): number {
  return root.events["_hooks"][name]?.length ?? 0;
}

describe("plugin unload undoes every registration", () => {
  it("removes listeners, effects and the provided service", async () => {
    const root = new Context();
    const cleanup = vi.fn();
    const fiber = await root.plugin(Greeter);
    fiber.ctx.effect(() => cleanup, "test-effect");

    expect(root.get("greeter")).toBeDefined();
    expect(listenerCount(root, "custom/event")).toBe(1);

    await fiber.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(root.get("greeter")).toBeUndefined();
    expect(listenerCount(root, "custom/event")).toBe(0);
    expect(fiber.getEffects()).toEqual([]);
  });

  it("keeps a consumer pending until the provider appears, then activates it", async () => {
    const root = new Context();
    const consumer = await root.plugin(Consumer);
    expect(listenerCount(root, "custom/event")).toBe(0);

    const provider = await root.plugin(Greeter);
    await vi.waitFor(() => expect(listenerCount(root, "custom/event")).toBe(2));

    await provider.dispose();
    await vi.waitFor(() => expect(listenerCount(root, "custom/event")).toBe(0));

    await consumer.dispose();
    expect(root.registry.size).toBe(0);
  });

  it("applies a config update by reloading without leaking registrations", async () => {
    const root = new Context();
    const setups = vi.fn();
    const teardowns = vi.fn();
    const fiber = await root.plugin(
      (ctx: Context, config: { value: number }) => {
        setups(config.value);
        ctx.on(CUSTOM_EVENT, () => undefined);
        ctx.effect(() => teardowns);
      },
      { value: 1 },
    );

    await fiber.update({ value: 2 });

    expect(setups.mock.calls).toEqual([[1], [2]]);
    expect(teardowns).toHaveBeenCalledTimes(1);
    expect(listenerCount(root, "custom/event")).toBe(1);

    await fiber.dispose();
    expect(teardowns).toHaveBeenCalledTimes(2);
    expect(listenerCount(root, "custom/event")).toBe(0);
  });

  it("disposing the parent disposes nested plugins", async () => {
    const root = new Context();
    const inner = vi.fn();
    const outer = await root.plugin((ctx: Context) => {
      ctx.plugin((child: Context) => {
        child.on(CUSTOM_EVENT, () => undefined);
        child.effect(() => inner);
      });
    });
    await vi.waitFor(() => expect(listenerCount(root, "custom/event")).toBe(1));

    await outer.dispose();

    expect(inner).toHaveBeenCalledTimes(1);
    expect(listenerCount(root, "custom/event")).toBe(0);
  });
});
