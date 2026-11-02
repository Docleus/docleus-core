import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { Context, Service } from "../src/index.ts";

// Local to this spike: @docleus/sdk declares the real `http` key on Context,
// so this test uses its own key to avoid colliding with that declaration.
declare module "../vendor/cordis/src/context.ts" {
  interface Context {
    spikeHttp: SpikeHttpService;
  }
}

type Handler = (c: { text: (body: string) => Response }) => Response;

class SpikeHttpService extends Service {
  private routes = new Map<string, Handler>();
  current = new Hono();

  constructor(ctx: Context) {
    super(ctx, "spikeHttp");
  }

  get(path: string, handler: Handler): () => void {
    return this.ctx.effect(() => {
      this.routes.set(path, handler);
      this.rebuild();
      return () => {
        this.routes.delete(path);
        this.rebuild();
      };
    });
  }

  fetch(path: string): Response | Promise<Response> {
    return this.current.fetch(new Request(`http://localhost${path}`));
  }

  private rebuild(): void {
    const next = new Hono();
    for (const [path, handler] of this.routes) next.get(path, handler);
    this.current = next;
  }
}

async function setup() {
  const root = new Context();
  await root.plugin(SpikeHttpService);
  return root;
}

describe("http service rebuilds the Hono router when plugins change", () => {
  it("serves routes while their plugin is loaded and 404s after it unloads", async () => {
    const root = await setup();
    const plugin = await root.plugin({
      inject: ["spikeHttp"],
      apply: (ctx: Context) => {
        ctx.spikeHttp.get("/hello", (c) => c.text("hi"));
      },
    });
    expect((await root.spikeHttp.fetch("/hello")).status).toBe(200);
    expect(await (await root.spikeHttp.fetch("/hello")).text()).toBe("hi");

    await plugin.dispose();

    expect((await root.spikeHttp.fetch("/hello")).status).toBe(404);
  });

  it("swaps atomically: an in-flight reference to the old router keeps working", async () => {
    const root = await setup();
    root.spikeHttp.get("/a", (c) => c.text("a"));
    const before = root.spikeHttp.current;

    root.spikeHttp.get("/b", (c) => c.text("b"));

    expect(root.spikeHttp.current).not.toBe(before);
    const old = await before.fetch(new Request("http://localhost/a"));
    expect(await old.text()).toBe("a");
    expect((await before.fetch(new Request("http://localhost/b"))).status).toBe(
      404,
    );
    expect(await (await root.spikeHttp.fetch("/b")).text()).toBe("b");
  });

  it("removes only the routes of the unloaded plugin", async () => {
    const root = await setup();
    const one = await root.plugin({
      inject: ["spikeHttp"],
      apply: (ctx: Context) => {
        ctx.spikeHttp.get("/one", (c) => c.text("1"));
      },
    });
    await root.plugin({
      inject: ["spikeHttp"],
      apply: (ctx: Context) => {
        ctx.spikeHttp.get("/two", (c) => c.text("2"));
      },
    });

    await one.dispose();

    expect((await root.spikeHttp.fetch("/one")).status).toBe(404);
    expect(await (await root.spikeHttp.fetch("/two")).text()).toBe("2");
  });

  it("drops a plugin's routes when the http provider itself is replaced", async () => {
    const root = new Context();
    const provider = await root.plugin(SpikeHttpService);
    const spy = vi.fn();
    await root.plugin({
      inject: ["spikeHttp"],
      apply: (ctx: Context) => {
        ctx.spikeHttp.get("/tied", (c) => c.text("tied"));
        ctx.effect(() => spy);
      },
    });
    expect((await root.spikeHttp.fetch("/tied")).status).toBe(200);

    await provider.dispose();

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(root.get("spikeHttp")).toBeUndefined();
  });
});
