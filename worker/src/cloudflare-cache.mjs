const DEFAULT_CACHE_TTL_MS = 15_000;

export function createCloudflareCacheAdapter(cache = globalThis.caches?.default) {
  if (!cache || typeof cache.match !== "function" || typeof cache.put !== "function") return null;
  const requestFor = (key) => new Request(`https://amrs-cache.invalid/v1/${encodeURIComponent(String(key))}`);
  return {
    async get(key) {
      return cache.match(requestFor(key));
    },
    async put(key, value, ttlMs) {
      const maxAge = Math.max(1, Math.ceil((Number(ttlMs) || DEFAULT_CACHE_TTL_MS) / 1000));
      await cache.put(requestFor(key), new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${maxAge}`,
        },
      }));
    },
  };
}
