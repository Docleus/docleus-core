export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** `fetch` against the instance as the signed-in user (by the session cookie). */
export function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

/** The {@link ApiError} of a failed response. */
export async function errorOf(response: Response): Promise<ApiError> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    return new ApiError(
      response.status,
      typeof body.code === "string" ? body.code : undefined,
      typeof body.message === "string" ? body.message : text,
    );
  } catch {
    return new ApiError(
      response.status,
      undefined,
      text || response.statusText,
    );
  }
}

/** A JSON API call; throws {@link ApiError} for any status other than 2xx. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await request(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await errorOf(response);
  const text = await response.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}
