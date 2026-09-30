/** In-memory token bucket (single web instance). Keys: `login:ip:<ip>`, `login:email:<email>`, … */
interface Bucket {
  tokens: number;
  updated: number;
}
const buckets = new Map<string, Bucket>();

export interface Limit {
  capacity: number; // burst size
  refillPerSec: number; // steady rate
}

export const LIMITS = {
  loginIp: { capacity: 20, refillPerSec: 20 / 300 }, // 20 per 5 min per IP
  loginEmail: { capacity: 8, refillPerSec: 8 / 900 }, // 8 per 15 min per email
  forgotIp: { capacity: 10, refillPerSec: 10 / 900 },
  forgotEmail: { capacity: 3, refillPerSec: 3 / 3600 },
} satisfies Record<string, Limit>;

export function take(key: string, limit: Limit, now = Date.now()): boolean {
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: limit.capacity, updated: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(limit.capacity, b.tokens + ((now - b.updated) / 1000) * limit.refillPerSec);
  b.updated = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  if (buckets.size > 50_000) prune(now);
  return true;
}

function prune(now: number) {
  for (const [k, b] of buckets) if (now - b.updated > 3600_000) buckets.delete(k);
}

export function resetRateLimits() {
  buckets.clear();
}
