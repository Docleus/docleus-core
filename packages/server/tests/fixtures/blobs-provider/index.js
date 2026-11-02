import { createHash } from "node:crypto";

export const plugin = {
  name: "test-blobs-provider",
  provide: ["blobs"],
  apply(ctx) {
    const objects = new Map();
    ctx.provide("blobs", {
      objects,
      async put(data) {
        const hash = createHash("sha256").update(data).digest("hex");
        objects.set(hash, new Uint8Array(data));
        return { hash, size: data.byteLength };
      },
      async get(hash) {
        return objects.get(hash);
      },
      async stat(hash) {
        const data = objects.get(hash);
        return data && { hash, size: data.byteLength };
      },
      async delete(hash) {
        return objects.delete(hash);
      },
      sign: (hash, expiresAt) => `${hash}.${expiresAt}`,
      verify: (token) => token.split(".")[0],
    });
  },
};
