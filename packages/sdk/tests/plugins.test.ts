import { Context } from "@docleus/kernel";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  auditDispatchModes,
  defineEvent,
  definePlugin,
  defineService,
  dispatch,
  provideService,
  useService,
} from "../src/index.ts";

interface Greeter {
  greet(name: string): string;
}

const greeter = defineService<Greeter>({
  name: "test.greeter",
  stability: "experimental",
  description: "Test service.",
});

const greeted = defineEvent({
  name: "test/greeted",
  mode: "parallel",
  stability: "experimental",
  description: "Test event.",
});

declare module "@docleus/kernel" {
  interface Context {
    "test.greeter": Greeter;
  }
}

// `on`/`emit` are typed as `keyof Events`. TypeScript does not merge an
// `Events` augmentation declared in a test file with the SDK's own
// augmentation in `../src/context.ts`, so this test event is untyped
// rather than declared through `declare module`.
const TEST_EVENT = "test/greeted" as never;

const listenerCount = (root: Context, name: string): number =>
  root.events["_hooks"][name]?.length ?? 0;

const provider = definePlugin({
  name: "test-provider",
  provides: [greeter],
  config: z.object({ greeting: z.string().default("hello") }),
  apply(ctx, config) {
    provideService(ctx, greeter, {
      greet: (name) => `${config.greeting}, ${name}`,
    });
    ctx.on(TEST_EVENT, () => undefined);
  },
});

const results: string[] = [];
const consumer = definePlugin({
  name: "test-consumer",
  inject: [greeter],
  apply(ctx) {
    results.push(useService(ctx, greeter).greet("world"));
    ctx.on(TEST_EVENT, () => undefined);
  },
});

describe("provider and consumer plugins", () => {
  it("waits for a provider that loads later, then activates the consumer", async () => {
    results.length = 0;
    const root = new Context();
    await root.plugin(consumer);
    expect(results).toEqual([]);

    await root.plugin(provider, { greeting: "hello" });

    await vi.waitFor(() => expect(results).toEqual(["hello, world"]));
  });

  it("validates plugin config with the zod schema", async () => {
    results.length = 0;
    const root = new Context();
    await root.plugin(provider, { greeting: "hi" });
    await root.plugin(consumer);

    await vi.waitFor(() => expect(results).toEqual(["hi, world"]));
  });

  it("rejects invalid config", async () => {
    const root = new Context();
    await expect(
      root.plugin(provider, { greeting: 42 } as unknown as {
        greeting: string;
      }),
    ).rejects.toThrow();
  });

  it("removes every listener and service once both plugins are disposed", async () => {
    const root = new Context();
    const providerFiber = await root.plugin(provider, { greeting: "hello" });
    const consumerFiber = await root.plugin(consumer);
    await vi.waitFor(() => expect(listenerCount(root, "test/greeted")).toBe(2));
    expect(root.get("test.greeter")).toBeDefined();

    await consumerFiber.dispose();
    await providerFiber.dispose();

    expect(listenerCount(root, "test/greeted")).toBe(0);
    expect(root.get("test.greeter")).toBeUndefined();
    expect(providerFiber.getEffects()).toEqual([]);
    expect(consumerFiber.getEffects()).toEqual([]);
    expect(root.registry.size).toBe(0);
  });
});

describe("dispatch mode audit", () => {
  it("passes when events are dispatched with their declared mode", async () => {
    const root = new Context();
    const mismatches = auditDispatchModes(root, [greeted]);
    await dispatch(root, greeted, "x");
    expect(mismatches).toEqual([]);
  });

  it("reports an event dispatched with another mode", () => {
    const root = new Context();
    const mismatches = auditDispatchModes(root, [greeted]);
    root.emit(TEST_EVENT, "x");
    expect(mismatches).toEqual([
      { event: "test/greeted", declared: "parallel", actual: "emit" },
    ]);
  });
});
