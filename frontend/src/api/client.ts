// Tiny fetch wrapper:
//   - Sends `credentials: "include"` so the middle-auth cookie rides along.
//     The cookie is set by middle-auth-client during the initial SPA-shell
//     load (see backend `_register_spa` in `api/__init__.py`); the SPA
//     itself never handles the token directly.
//   - Throws an ApiCallError so TanStack Query surfaces a useful message.

import type { ApiError } from "./types";

export class ApiCallError extends Error {
  status: number;
  body: ApiError | null;
  constructor(status: number, body: ApiError | null) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let url = path;
  if (opts.query) {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
    }
    const qs = search.toString();
    if (qs) url += `?${qs}`;
  }
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    credentials: "include",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!resp.ok) {
    let body: ApiError | null = null;
    try {
      body = await resp.json();
    } catch {
      // ignore
    }
    throw new ApiCallError(resp.status, body);
  }
  return resp.json() as Promise<T>;
}
