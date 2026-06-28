import { TtlCache } from "../cache/lru.js";
import { CircuitBreaker, RateLimiter, withRetry, HttpError } from "../resilience/index.js";
import { getCobaltToken, getAllCookies, buildAuthHeadersFromCookies } from "./auth.js";

export class DdbClient {
  private authExpired = false;

  constructor(
    private readonly cache: TtlCache<unknown>,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly rateLimiter: RateLimiter,
  ) {}

  get isAuthExpired(): boolean {
    return this.authExpired;
  }

  invalidateCache(key: string): void {
    this.cache.invalidate(key);
  }

  async get<T>(url: string, cacheKey: string, ttl?: number): Promise<T> {
    const cached = this.cache.get(cacheKey) as T | undefined;
    if (cached !== undefined) return cached;

    const result = await this.request<T>(url, { method: "GET" });
    this.cache.set(cacheKey, result, ttl);
    return result;
  }

  /**
   * Like get(), but also reports whether the value came from cache and how old
   * it is — so callers can show a freshness indicator. Pass forceRefresh to
   * bypass the cache and fetch live.
   */
  async getWithMeta<T>(
    url: string,
    cacheKey: string,
    ttl?: number,
    forceRefresh = false,
  ): Promise<{ value: T; fromCache: boolean; ageMs: number }> {
    if (forceRefresh) this.cache.invalidate(cacheKey);

    const ageMs = this.cache.ageOf(cacheKey);
    if (ageMs !== undefined) {
      return { value: this.cache.get(cacheKey) as T, fromCache: true, ageMs };
    }

    const result = await this.request<T>(url, { method: "GET" });
    this.cache.set(cacheKey, result, ttl);
    return { value: result, fromCache: false, ageMs: 0 };
  }

  /**
   * GET that returns the raw JSON without envelope unwrapping.
   * Used for monster-service which has its own response format.
   */
  async getRaw<T>(url: string, cacheKey: string, ttl?: number): Promise<T> {
    const cached = this.cache.get(cacheKey) as T | undefined;
    if (cached !== undefined) return cached;

    const result = await this.requestRaw<T>(url, { method: "GET" });
    this.cache.set(cacheKey, result, ttl);
    return result;
  }

  async post<T>(url: string, body: unknown, invalidateCacheKeys?: string[]): Promise<T> {
    const result = await this.request<T>(url, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (invalidateCacheKeys) {
      for (const key of invalidateCacheKeys) {
        this.cache.invalidate(key);
      }
    }
    return result;
  }

  async put<T>(url: string, body: unknown, invalidateCacheKeys?: string[]): Promise<T> {
    const result = await this.request<T>(url, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (invalidateCacheKeys) {
      for (const key of invalidateCacheKeys) {
        this.cache.invalidate(key);
      }
    }
    return result;
  }

  async delete<T>(url: string, body: unknown, invalidateCacheKeys?: string[]): Promise<T> {
    const result = await this.request<T>(url, {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    if (invalidateCacheKeys) {
      for (const key of invalidateCacheKeys) {
        this.cache.invalidate(key);
      }
    }
    return result;
  }

  /**
   * Build an HttpError for a failed response, including the response body when
   * present. D&D Beyond returns a validation message in the body on 4xx (e.g.
   * why a write was rejected); without it a bare "400 Bad Request" is undebuggable.
   */
  private async toHttpError(response: Response): Promise<HttpError> {
    if (response.status === 401) this.authExpired = true;
    const body =
      typeof response.text === "function" ? await response.text().catch(() => "") : "";
    const detail = body ? ` — ${body.slice(0, 500)}` : "";
    return new HttpError(
      `D&D Beyond API error: ${response.status} ${response.statusText}${detail}`,
      response.status,
    );
  }

  private async requestRaw<T>(url: string, options: RequestInit): Promise<T> {
    await this.rateLimiter.acquire();

    return this.circuitBreaker.execute(() =>
      withRetry(async () => {
        const headers = await this.buildHeaders(url);
        const response = await fetch(url, { ...options, headers });

        if (!response.ok) {
          throw await this.toHttpError(response);
        }

        return (await response.json()) as T;
      })
    );
  }

  private async request<T>(url: string, options: RequestInit): Promise<T> {
    await this.rateLimiter.acquire();

    return this.circuitBreaker.execute(() =>
      withRetry(async () => {
        const headers = await this.buildHeaders(url);
        const response = await fetch(url, { ...options, headers });

        if (!response.ok) {
          throw await this.toHttpError(response);
        }

        const json = await response.json();

        // D&D Beyond APIs use two envelope formats:
        //   Character-service: { id, success, message, data }
        //   Campaign/Waterdeep: { status: "success", data }
        // Unwrap both so callers always receive the data directly.
        if (json && typeof json === "object" && "data" in json) {
          // Character-service envelope: check `success` boolean
          if ("success" in json) {
            if (!json.success) {
              throw new HttpError(
                `D&D Beyond API error: ${json.message || "Unknown error"}`,
                400,
              );
            }
            return json.data as T;
          }
          // Waterdeep envelope: check `status` string
          if ("status" in json && json.status === "success") {
            return json.data as T;
          }
        }

        return json as T;
      })
    );
  }

  private async buildHeaders(url: string): Promise<Record<string, string>> {
    // character-service and monster-service use bearer tokens
    if (
      url.includes("character-service.dndbeyond.com") ||
      url.includes("monster-service.dndbeyond.com")
    ) {
      const token = await getCobaltToken();
      return {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
    }

    // dndbeyond.com endpoints use cookies + cobalt token header
    const cookies = await getAllCookies();
    if (cookies.length === 0) throw new Error("Not authenticated. Run setup first.");

    const token = await getCobaltToken();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return {
      Cookie: cookieStr,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }
}
