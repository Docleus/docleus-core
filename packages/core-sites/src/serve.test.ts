import { describe, expect, it } from "vitest";
import { decodePath, serveArtifact, siteRootOf } from "./serve.ts";

describe("decodePath", () => {
  it("decodes each segment and rejects segments that would leave the site", () => {
    expect(decodePath("/caf%C3%A9/")).toBe("/café/");
    expect(decodePath("guide")).toBe("/guide");
    for (const raw of [
      "/..",
      "/a/./b",
      "/a%2Fb",
      "/a%5Cb",
      "/%00",
      "/%E0%A4%A",
    ]) {
      expect(decodePath(raw)).toBeUndefined();
    }
  });
});

describe("siteRootOf", () => {
  it("strips the site-relative path from the request path", () => {
    const request = new Request("http://x.test/sites/acme/docs/guide/");
    expect(siteRootOf(request, "/guide/")).toBe("/sites/acme/docs/");
    expect(siteRootOf(new Request("http://docs.test/a/"), "/a/")).toBe("/");
  });
});

describe("serveArtifact", () => {
  const artifact = {
    format: 1 as const,
    files: { "/a.txt": { hash: "h1", type: "text/plain", size: 1 } },
  };
  const source = {
    artifact,
    readBlob: async () => new TextEncoder().encode("a"),
  };

  it("treats weak and wildcard If-None-Match values as matches", async () => {
    for (const tag of ['W/"h1"', "*", '"x", "h1"']) {
      const response = await serveArtifact(
        new Request("http://x.test/a.txt", {
          headers: { "if-none-match": tag },
        }),
        "/a.txt",
        source,
      );
      expect(response.status).toBe(304);
    }
  });

  it("serves views over plain and shared buffers byte for byte", async () => {
    const plain = new Uint8Array([0, 97, 98, 0]).subarray(1, 3);
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    shared.set([97, 98]);
    for (const bytes of [plain, shared]) {
      const response = await serveArtifact(
        new Request("http://x.test/a.txt"),
        "/a.txt",
        { artifact, readBlob: async () => bytes },
      );
      expect(response.headers.get("content-length")).toBe("2");
      expect(await response.text()).toBe("ab");
    }
  });

  it("answers a plain 404 when the artifact has no 404 page", async () => {
    const response = await serveArtifact(
      new Request("http://x.test/missing"),
      "/missing",
      source,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
  });
});
