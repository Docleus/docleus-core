import { createTestInstance, type TestInstance } from "@docleus/testing";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    await expect(held.done).rejects.toMatchObject({
      code: "plugin/install-lease-lost",
    });
  });

  it("remembers a takeover detected by renewal even if the holder row returns", async () => {
    const { ctx } = await storage();
    const lock = createInstallLock(ctx, { renewMs: 5 });
    const gate = deferred();
    const held = holding(lock, gate);
    const outcome = held.done.catch((error: unknown) => error);
    await held.started;
    const result = await sql<{ holder: string }>`
      SELECT holder FROM plugin_install_lock WHERE key = 'plugins'
    `.execute(ctx.storage.db);
    const holder = result.rows[0]?.holder;
    expect(holder).toBeDefined();
    try {
      await sql`UPDATE plugin_install_lock SET holder = 'other-holder'`.execute(
        ctx.storage.db,
      );
      await expect
        .poll(() =>
          ctx.logger.buffer.some(
            (message) => message.name === "plugins" && message.type === "warn",
          ),
        )
        .toBe(true);
      await sql`UPDATE plugin_install_lock SET holder = ${holder}`.execute(
        ctx.storage.db,
      );
    } finally {
      gate.resolve();
      await outcome;
    }
    expect(await outcome).toMatchObject({
      code: "plugin/install-lease-lost",
    });
  });

  it("does not resurrect an expired lease at a mutation checkpoint", async () => {
    const { ctx } = await storage();
    const lock = createInstallLock(ctx, { renewMs: 60_000 });
    let mutated = false;
    await expect(
      lock.run(async (check) => {
        await sql`UPDATE plugin_install_lock SET expires_at = 0`.execute(
          ctx.storage.db,
        );
        await check();
        mutated = true;
      }),
    ).rejects.toMatchObject({ code: "plugin/install-lease-lost" });
    expect(mutated).toBe(false);
    expect(await lock.run(async () => "next")).toBe("next");
  });

  it("preserves a renewal error even if releasing the lease also fails", async () => {
    const { ctx } = await storage();
    const lock = createInstallLock(ctx, { renewMs: 60_000 });
    const cause = new Error("injected renewal failure");
    await expect(
      lock.run(async (check) => {
        vi.spyOn(ctx.storage.db, "deleteFrom").mockImplementationOnce(() => {
          throw new Error("injected release failure");
        });
        vi.spyOn(ctx.storage.db, "updateTable").mockImplementationOnce(() => {
          throw cause;
        });
        await check();
      }),
    ).rejects.toMatchObject({ code: "plugin/install-lease-lost", cause });
    await sql`DELETE FROM plugin_install_lock`.execute(ctx.storage.db);
    expect(await lock.run(async () => "next")).toBe("next");
  });

  it("rejects a renewal that finishes after its renewed expiry", async () => {
    const { ctx } = await storage();
    const lock = createInstallLock(ctx, { leaseMs: 1000, renewMs: 60_000 });
    let mutated = false;
    await expect(
      lock.run(async (check) => {
        const now = Date.now();
        vi.spyOn(Date, "now")
          .mockReturnValueOnce(now)
          .mockReturnValue(now + 1000);
        await check();
        mutated = true;
      }),
    ).rejects.toMatchObject({ code: "plugin/install-lease-lost" });
    expect(mutated).toBe(false);
  });

  it("does not release the lease row belonging to a new holder", async () => {
    const { ctx } = await storage();
    const lock = createInstallLock(ctx, { renewMs: 60_000 });
    await expect(
      lock.run(async () => {
        await sql`UPDATE plugin_install_lock SET holder = 'other-holder'`.execute(
          ctx.storage.db,
        );
        return "stale success";
      }),
    ).rejects.toMatchObject({ code: "plugin/install-lease-lost" });
    const result = await sql<{ holder: string }>`
      SELECT holder FROM plugin_install_lock WHERE key = 'plugins'
    `.execute(ctx.storage.db);
    expect(result.rows).toEqual([{ holder: "other-holder" }]);
  });

  it("defers renewal during storage handoff but checks the lease before later writes", async () => {
    const { ctx } = await storage();
    const lock = createInstallLock(ctx, { renewMs: 5 });
    let mutated = false;
    await expect(
      lock.run(async (check) => {
        await check.replaceStorage(async () => {
          await sql`UPDATE plugin_install_lock SET holder = 'other-holder'`.execute(
            ctx.storage.db,
          );
          await new Promise((done) => setTimeout(done, 30));
          expect(
            ctx.logger.buffer.some((message) => message.type === "warn"),
          ).toBe(false);
        });
        mutated = true;
      }),
    ).rejects.toMatchObject({ code: "plugin/install-lease-lost" });
    expect(mutated).toBe(false);
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
