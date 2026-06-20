import { StorageAdapter } from "grammy";

/**
 * Native grammY Storage Adapter for Cloudflare Workers KV
 */
export function kvStorage<T>(kv: KVNamespace, ttlSeconds = 86400): StorageAdapter<T> {
  return {
    async read(key: string) {
      const data = await kv.get(key, "json");
      return (data as T) || undefined;
    },
    async write(key: string, value: T) {
      // Store session with expiration TTL (default: 24 hours)
      await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
    },
    async delete(key: string) {
      await kv.delete(key);
    },
  };
}