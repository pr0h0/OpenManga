export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export const API_BASE = "/api";

function csrfToken() {
  return document.cookie.match(/(?:^|;\s*)om_csrf=([^;]+)/)?.[1] ?? "";
}

async function ensureCsrf() {
  if (!csrfToken()) await fetch(`${API_BASE}/auth/me`, { credentials: "include" });
}

/** Asks before going over a project's AI budget; replaced by a dialog-based prompt in the app shell. */
export let confirmOverBudget: (message: string) => Promise<boolean> = async (m) =>
  window.confirm(`${m}\n\nContinue anyway?`);
export const setOverBudgetPrompt = (fn: typeof confirmOverBudget) => {
  confirmOverBudget = fn;
};

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; raw?: boolean; overBudget?: boolean } = {},
): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (e) {
    if (
      e instanceof ApiError &&
      e.code === "budget_exceeded" &&
      !init.overBudget &&
      (await confirmOverBudget(e.message))
    )
      return request<T>(path, { ...init, overBudget: true });
    throw e;
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; raw?: boolean; overBudget?: boolean },
): Promise<T> {
  const method = init.method ?? "GET";
  // This helper serialises the body itself. A string here means the caller stringified it too, which the server
  // parses back to a string and rejects with "expected object, received string" — a confusing error a long way
  // from its cause, so fail at the call site instead. Checked before anything else happens.
  if (typeof init.body === "string")
    throw new Error(`${path}: pass the object to api(), not JSON.stringify(...) — it is serialised here`);
  const headers: Record<string, string> = init.overBudget ? { "x-allow-over-budget": "1" } : {};
  let body: BodyInit | undefined;
  if (method !== "GET") {
    await ensureCsrf();
    headers["x-csrf-token"] = decodeURIComponent(csrfToken());
  }
  if (init.body instanceof FormData) body = init.body;
  else if (init.body instanceof Blob) {
    // Raw body, so a large upload is streamed to the server rather than assembled in memory on both sides.
    headers["content-type"] = init.body.type || "application/octet-stream";
    body = init.body;
  } else if (init.body !== undefined) {
    // This helper serialises the body itself. A string here means the caller stringified it too, which the
    // server parses back to a string and rejects with "expected object, received string" — a confusing error a
    // long way from its cause, so fail loudly at the call site instead.
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body, credentials: "include", signal: init.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", "Cannot reach the server. Check your connection.");
  }
  if (init.raw) {
    if (!res.ok) throw await toError(res);
    return res as unknown as T;
  }
  if (!res.ok) throw await toError(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function toError(res: Response) {
  let payload: { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } = {};
  try {
    payload = await res.json();
  } catch {}
  const e = payload.error;
  const fallback =
    res.status === 413
      ? "File is too large"
      : res.status >= 500
        ? "Server error. Please try again."
        : `Request failed (${res.status})`;
  return new ApiError(res.status, e?.code ?? "http_error", e?.message ?? fallback, e?.details, e?.requestId);
}

export const get = <T>(p: string) => api<T>(p);
export const post = <T>(p: string, body?: unknown) => api<T>(p, { method: "POST", body: body ?? {} });
export const patch = <T>(p: string, body?: unknown) => api<T>(p, { method: "PATCH", body: body ?? {} });
export const put = <T>(p: string, body?: unknown) => api<T>(p, { method: "PUT", body: body ?? {} });
export const del = <T>(p: string) => api<T>(p, { method: "DELETE" });

export const assetUrl = (
  assetId: string | null | undefined,
  variant?: "thumbnail" | "prompt_ref" | "preview" | "web",
  download?: string,
) =>
  assetId
    ? `/cdn/a/${assetId}${variant || download ? "?" : ""}${variant ? `v=${variant}` : ""}${variant && download ? "&" : ""}${download ? `download=${encodeURIComponent(download)}` : ""}`
    : "";

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === "validation_error" && Array.isArray(e.details))
      return `${e.message}: ${(e.details as { path: string; message: string }[]).map((d) => `${d.path || "input"} ${d.message}`).join("; ")}`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
