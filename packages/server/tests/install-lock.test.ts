import { createTestInstance, type TestInstance } from "@docleus/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createInstallLock, type InstallLock } from "../src/install-lock.ts";

const instances: TestInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

async function storage(): Promise<TestInstance> {
  const instance = await createTestInstance();
  instances.push(instance);
  return instance;
}

const noop = () => undefined;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Runs a task on `lock` that holds it until `gate` resolves. */
function holding(lock: InstallLock, gate: { promise: Promise<void> }) {
  const started = deferred();
  const done = lock.run(async () => {
    started.resolve();
    await gate.promise;
  });
  return { started: started.promise, done };
}

describe("install lock", () => {
  it("runs the tasks of two holders one after another", async () => {
    const { ctx } = await storage();
    const first = createInstallLock(ctx, { pollMs: 5 });
    const second = createInstallLock(ctx, { pollMs: 5 });
    const events: string[] = [];
    const gate = deferred();

    const a = first.run(async () => {
      events.push("a:start");
      await gate.promise;
      events.push("a:end");
    });
    await expect.poll(() => events).toEqual(["a:start"]);
    const b = second.run(async () => {
      events.push("b");
    });
    await new Promise((done) => setTimeout(done, 30));
    expect(events).toEqual(["a:start"]);
    gate.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b"]);
  });

  it("releases the lease when the task fails", async () => {
    const { ctx } = await storage();
    const lock = createInstallLock(ctx, { pollMs: 5, waitMs: 200 });
    await expect(
      lock.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lock.run(async () => "next")).toBe("next");
  });

  it("refuses with plugin/install-busy after waiting too long", async () => {
    const { ctx } = await storage();
    const holder = createInstallLock(ctx);
    const waiter = createInstallLock(ctx, { pollMs: 5, waitMs: 50 });
    const gate = deferred();
    const held = holding(holder, gate);
    await held.started;
    await expect(waiter.run(async () => undefined)).rejects.toMatchObject({
      code: "plugin/install-busy",
    });
    gate.resolve();
    await held.done;
  });

  it("takes over the lease of a holder that stopped renewing it", async () => {
    const { ctx } = await storage();
    const crashed = createInstallLock(ctx, { leaseMs: 40, renewMs: 60_000 });
    const waiter = createInstallLock(ctx, { pollMs: 5, waitMs: 2000 });
    const gate = deferred();
    const held = holding(crashed, gate);
    await held.started;
    expect(await waiter.run(async () => "taken over")).toBe("taken over");
    gate.resolve();
    await held.done;
  });

  it("keeps the lease while the holder renews it", async () => {
    const { ctx } = await storage();
    const holder = createInstallLock(ctx, { leaseMs: 200, renewMs: 20 });
    const waiter = createInstallLock(ctx, { pollMs: 5, waitMs: 600 });
    const gate = deferred();
    const held = holding(holder, gate);
    await held.started;
    await expect(waiter.run(async () => undefined)).rejects.toMatchObject({
      code: "plugin/install-busy",
    });
    gate.resolve();
    await held.done;
  });
});
