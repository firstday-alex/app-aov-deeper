// Config persistence. Uses Upstash/Vercel KV when configured, otherwise falls
// back to a non-persistent in-memory store (handy for local dev).
import { Redis } from "@upstash/redis";

const CONFIG_KEY = "aov-deeper:config";

let redis = null;
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (url && token) {
  redis = new Redis({ url, token });
}

// Module-scoped fallback. Survives within a warm serverless instance only.
const memory = new Map();

export const persistenceMode = redis ? "kv" : "memory";

export async function readConfig() {
  if (redis) {
    return (await redis.get(CONFIG_KEY)) || null;
  }
  return memory.get(CONFIG_KEY) || null;
}

export async function writeConfig(config) {
  if (redis) {
    await redis.set(CONFIG_KEY, config);
  } else {
    memory.set(CONFIG_KEY, config);
  }
  return config;
}

// Generic small-value cache (used to remember completed bulk-export op ids so a
// re-run with the same fetch window can skip re-querying Shopify). TTL in seconds.
export async function cacheGet(key) {
  if (redis) return (await redis.get(key)) || null;
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.exp && entry.exp < nowSeconds()) {
    memory.delete(key);
    return null;
  }
  return entry.val;
}

export async function cacheSet(key, val, ttlSeconds) {
  if (redis) {
    await redis.set(key, val, ttlSeconds ? { ex: ttlSeconds } : undefined);
  } else {
    memory.set(key, { val, exp: ttlSeconds ? nowSeconds() + ttlSeconds : 0 });
  }
  return val;
}

// Date.now() is fine in app runtime (only workflow scripts forbid it).
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
