import { isAbsolute } from "node:path";
import { DocleusError, type Context } from "@docleus/kernel";
import { z } from "zod";
import type { PluginManager } from "../plugin-manager.ts";
import { handle, json, param, readBody } from "./respond.ts";

/** Upper bound on an uploaded plugin tarball. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const INSTANCE = { kind: "instance" } as const;
const asAdmin = {
  authorize: { action: "manage", resource: INSTANCE },
} as const;

const installBody = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("path"),
    path: z.string().min(1).refine(isAbsolute, "expected an absolute path"),
  }),
  z.strictObject({
    type: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().min(1),
  }),
]);

async function readUpload(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) {
    throw new DocleusError("api/invalid-request", "expected a .tgz body");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  if (size === 0) {
    throw new DocleusError("api/invalid-request", "expected a .tgz body");
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

function tooLarge(): DocleusError {
  return new DocleusError(
    "api/too-large",
    `the upload is larger than ${MAX_UPLOAD_BYTES} bytes`,
  );
}

function filenameOf(request: Request): string | undefined {
  const name = new URL(request.url).searchParams.get("filename");
  return name && /^[\w.@+-]{1,200}$/.test(name) ? name : undefined;
}

/**
 * Instance-admin plugin management: list mounted plugins, install from a
 * server path, a Git ref or an uploaded `.tgz`, and uninstall.
 */
export function registerPluginAdminApi(
  ctx: Context,
  manager: PluginManager,
): void {
  ctx.http.route(
    "GET",
    "/api/plugins",
    handle(ctx, async () => json({ plugins: manager.list() })),
    asAdmin,
  );

  ctx.http.route(
    "POST",
    "/api/plugins",
    handle(ctx, async (context) => {
      const source = await readBody(context.request, installBody);
      return json({ plugin: await manager.install(source) }, 201);
    }),
    asAdmin,
  );

  ctx.http.route(
    "POST",
    "/api/plugins/upload",
    handle(ctx, async (context) => {
      const data = await readUpload(context.request);
      const filename = filenameOf(context.request);
      return json(
        {
          plugin: await manager.install({
            type: "tarball",
            data,
            ...(filename && { filename }),
          }),
        },
        201,
      );
    }),
    asAdmin,
  );

  ctx.http.route(
    "DELETE",
    "/api/plugins/:name",
    handle(ctx, async (context) => {
      await manager.uninstall(param(context, "name"));
      return new Response(null, { status: 204 });
    }),
    asAdmin,
  );
}
