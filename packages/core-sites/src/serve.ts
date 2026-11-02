import type { Artifact, ArtifactFile } from "@docleus/sdk";

export const NOT_FOUND_PATH = "/404.html";
export const NOT_FOUND_BASE = '<base href="./">';

export interface ServeArtifact {
  readonly artifact: Artifact | undefined;
  readBlob(hash: string): Promise<Uint8Array | undefined>;
}

function plain(
  status: number,
  text: string,
  headers?: Record<string, string>,
): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

// The DOM lib only accepts views over a plain ArrayBuffer as a body; Node's
// `Response` accepts any view. Copy only views over a SharedArrayBuffer.
function bodyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return isOverArrayBuffer(bytes) ? bytes : new Uint8Array(bytes);
}

function isOverArrayBuffer(
  bytes: Uint8Array,
): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

/** Decoded segments, or `undefined` when a segment is invalid or would leave the site. */
export function decodePath(raw: string): string | undefined {
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      return undefined;
    }
    segments.push(decoded);
  }
  const path = segments.join("/");
  return path.startsWith("/") ? path : `/${path}`;
}

/** The site root as seen by the requester: the request path without the site-relative `raw` suffix. */
export function siteRootOf(request: Request, raw: string): string {
  const { pathname } = new URL(request.url);
  const suffix = raw.startsWith("/") ? raw : `/${raw}`;
  if (pathname.endsWith(suffix)) {
    return `${pathname.slice(0, pathname.length - suffix.length)}/`;
  }
  return "/";
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

function escapeAttribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

async function respondFile(
  request: Request,
  source: ServeArtifact,
  file: ArtifactFile,
): Promise<Response> {
  const etag = `"${file.hash}"`;
  const headers = {
    "content-type": file.type,
    etag,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  };
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  const bytes = await source.readBlob(file.hash);
  if (!bytes) return plain(404, "Not Found");
  return new Response(request.method === "HEAD" ? null : bodyOf(bytes), {
    headers: { ...headers, "content-length": String(bytes.byteLength) },
  });
}

async function notFound(
  request: Request,
  source: ServeArtifact,
  root: string,
): Promise<Response> {
  const file = source.artifact?.files[NOT_FOUND_PATH];
  const bytes = file && (await source.readBlob(file.hash));
  if (!file || !bytes) return plain(404, "Not Found");
  const html = new TextDecoder()
    .decode(bytes)
    .replace(NOT_FOUND_BASE, `<base href="${escapeAttribute(root)}">`);
  return new Response(request.method === "HEAD" ? null : html, {
    status: 404,
    headers: {
      "content-type": file.type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Answers a request for the site-relative, still percent-encoded `raw`
 * path from an artifact.
 */
export async function serveArtifact(
  request: Request,
  raw: string,
  source: ServeArtifact,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method Not Allowed", { allow: "GET, HEAD" });
  }
  const { artifact } = source;
  if (!artifact) return plain(404, "Not Found");
  const root = siteRootOf(request, raw);
  const path = decodePath(raw);
  if (path === undefined) return notFound(request, source, root);
  if (path.endsWith("/")) {
    const index = artifact.files[`${path}index.html`];
    return index
      ? respondFile(request, source, index)
      : notFound(request, source, root);
  }
  const file = artifact.files[path];
  if (file) return respondFile(request, source, file);
  if (artifact.files[`${path}/index.html`]) {
    const url = new URL(request.url);
    return new Response(null, {
      status: 308,
      headers: { location: `${url.pathname}/${url.search}` },
    });
  }
  return notFound(request, source, root);
}
