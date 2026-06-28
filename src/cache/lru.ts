interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  storedAt: number;
}

export class TtlCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private readonly defaultTtl: number;
  private readonly maxSize: number;

  constructor(defaultTtlMs: number, maxSize = 1000) {
    this.defaultTtl = defaultTtlMs;
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.entries.size >= this.maxSize) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtl),
      storedAt: Date.now(),
    });
  }

  /**
   * Age in ms of a live entry, or undefined if absent/expired. Lets callers
   * surface how stale a cached value is (freshness check) without consuming it.
   */
  ageOf(key: string): number | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return Date.now() - entry.storedAt;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
