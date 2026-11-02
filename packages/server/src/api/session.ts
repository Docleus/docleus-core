import { SESSION_COOKIE } from "@docleus/sdk";

/** The session token a request carries: the bearer token, else the session cookie. */
export function sessionToken(request: Request): string | undefined {
  const bearer = /^bearer\s+(\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (bearer) return bearer;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

export interface OriginOptions {
  readonly publicUrl?: string | undefined;
  readonly trustProxy?: boolean | undefined;
}

/** The origin users reach the instance at, for links the instance hands out. */
export function publicOrigin(request: Request, options: OriginOptions): string {
  if (options.publicUrl) return options.publicUrl.replace(/\/+$/, "");
  const url = new URL(request.url);
  if (!options.trustProxy) return url.origin;
  const first = (name: string) =>
    request.headers.get(name)?.split(",")[0]?.trim() || undefined;
  const protocol = first("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  const host = first("x-forwarded-host") ?? url.host;
  return `${protocol}://${host}`;
}
