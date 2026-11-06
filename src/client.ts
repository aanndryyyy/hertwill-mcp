/**
 * Minimal HTTP client for the Hertwill Public API (https://hertwill.com/docs).
 */

export const DEFAULT_BASE_URL = "https://api.hertwill.com";

export class HertwillApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
    readonly rateLimit?: string | null,
  ) {
    super(message);
    this.name = "HertwillApiError";
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface HertwillClientOptions {
  apiKey?: string;
  baseUrl?: string;
  userAgent?: string;
}

export class HertwillClient {
  readonly apiKey?: string;
  readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(opts: HertwillClientOptions = {}) {
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.userAgent = opts.userAgent ?? "hertwill-mcp";
  }

  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  /** Throw API_KEY_MISSING unless a key is configured. */
  assertKey(): void {
    if (!this.apiKey) {
      throw new HertwillApiError(
        401,
        "API_KEY_MISSING",
        "This tool needs a Hertwill API key. Set the HERTWILL_API_KEY environment variable in your MCP client config " +
          "(create a store-scoped key at https://hertwill.com in your account dashboard).",
      );
    }
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    { query, body, requireKey = false }: { query?: Query; body?: unknown; requireKey?: boolean } = {},
  ): Promise<T> {
    if (requireKey) this.assertKey();

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    // Send the key on every request when we have one: it also unlocks wholesale prices on catalog endpoints.
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new HertwillApiError(0, "NETWORK_ERROR", `Could not reach ${url.origin}: ${(err as Error).message}`);
    }

    const text = await res.text();
    let json: any = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!res.ok) {
      const e = json?.error ?? {};
      let message: string = e.message || text.slice(0, 500) || res.statusText || "Request failed";
      const rateLimit = res.headers.get("ratelimit");
      if (res.status === 429) {
        const reset = rateLimit?.match(/t=(\d+)/)?.[1];
        message += reset ? ` (rate limited; retry in ~${reset}s)` : " (rate limited; retry shortly)";
      }
      throw new HertwillApiError(
        res.status,
        e.code || `HTTP_${res.status}`,
        message,
        e.details,
        json?.meta?.request_id,
        rateLimit,
      );
    }

    return (json ?? {}) as T;
  }
}
