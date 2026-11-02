import { afterEach, describe, expect, it } from "vitest";
import type { Instance } from "../src/index.ts";
import { bootWith, ORIGIN } from "./helpers.ts";

const instances: Instance[] = [];
const boot = bootWith(instances);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

async function enqueueProbe(instance: Instance) {
  const ran: unknown[] = [];
  const stop = instance.ctx.jobs.handle("test/probe", async (job) => {
    ran.push(job.payload);
  });
  await instance.ctx.jobs.enqueue("test/probe", { n: 1 });
  return { ran, stop };
}

async function settle(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("process roles", () => {
  it("runs due jobs in the background by default", async () => {
    const instance = await boot();
    const { ran, stop } = await enqueueProbe(instance);
    await expect.poll(() => ran, { timeout: 5000 }).toEqual([{ n: 1 }]);
    stop();
  });

  it("leaves jobs to workers in the web role", async () => {
    const instance = await boot({ role: "web" });
    const { ran, stop } = await enqueueProbe(instance);
    await settle(1500);
    expect(ran).toEqual([]);
    expect(await instance.ctx.jobs.runOnce()).toBe(1);
    expect(ran).toEqual([{ n: 1 }]);
    stop();
  });

  it("registers no HTTP routes in the worker role", async () => {
    const plugins = [{ id: "route", plugin: "route" }];
    const web = await boot({ role: "web", plugins });
    expect(web.ctx.http.routes()).toContainEqual(
      expect.objectContaining({ path: "/api/test/route" }),
    );
    const worker = await boot({ role: "worker", plugins });
    expect(worker.ctx.http.routes()).toEqual([]);
    const response = await worker.ctx.http.fetch(
      new Request(`${ORIGIN}/api/test/route`),
    );
    expect(response.status).toBe(404);
    expect(worker.setupToken).toBeUndefined();
  });

  it("runs jobs in the worker role", async () => {
    const instance = await boot({ role: "worker" });
    const { ran, stop } = await enqueueProbe(instance);
    await expect.poll(() => ran, { timeout: 5000 }).toEqual([{ n: 1 }]);
    stop();
  });
});
