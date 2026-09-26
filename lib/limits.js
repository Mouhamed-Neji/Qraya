/* Best-effort protections so one visitor cannot drain a free AI quota.
 *
 * Serverless instances do not share memory, so these counters are per-instance:
 * they stop a single abusive client (the realistic threat on a free key) but they
 * are NOT a distributed quota. For a hard global cap set FREE_DAILY_LIMIT and put
 * a shared store (Upstash/Redis) behind Counter — see README "Hard limits".
 */

const buckets = new Map(); // key -> [timestamps]
const daily = new Map(); // day -> count

export const LIMITS = {
  perIpPerHour: Number(process.env.RATE_IP_PER_HOUR || 30),
  perIpPerDay: Number(process.env.RATE_IP_PER_DAY || 120),
  globalPerDay: Number(process.env.FREE_DAILY_LIMIT || 0), // 0 = unlimited
  maxTextChars: Number(process.env.MAX_TEXT_CHARS || 120000),
  maxQuestions: Number(process.env.MAX_QUESTIONS || 30),
};

const dayKey = () => new Date().toISOString().slice(0, 10);

export function checkRate(ip) {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const dayAgo = now - 86400_000;

  const hits = (buckets.get(ip) || []).filter(t => t > dayAgo);
  const lastHour = hits.filter(t => t > hourAgo).length;

  if (LIMITS.globalPerDay > 0) {
    const today = daily.get(dayKey()) || 0;
    if (today >= LIMITS.globalPerDay) {
      return { ok: false, scope: "global", message: "Free AI quota for today is exhausted. The app keeps working with on-device analysis." };
    }
  }
  if (lastHour >= LIMITS.perIpPerHour) return { ok: false, scope: "hour", retryAfter: 3600 - Math.round((now - hits[0]) / 1000) };
  if (hits.length >= LIMITS.perIpPerDay) return { ok: false, scope: "day", retryAfter: 86400 };

  hits.push(now);
  buckets.set(ip, hits);
  if (buckets.size > 5000) buckets.clear(); // memory guard
  return { ok: true };
}

export function countUsage() {
  const k = dayKey();
  daily.set(k, (daily.get(k) || 0) + 1);
}

/* ------------------------------------------------------------------- cache
 * Analysis of a document is deterministic given its text, so a repeat upload of
 * the same file should never hit the model (or the quota) twice.
 */
const CACHE_MAX = Number(process.env.CACHE_ENTRIES || 40);
const cache = new Map();

export function cacheKey(prefix, text) {
  // FNV-1a over the text: cheap, stable, good enough for cache identity.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${prefix}:${h.toString(36)}:${text.length}`;
}

export function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit); // refresh LRU position
  return hit;
}

export function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
