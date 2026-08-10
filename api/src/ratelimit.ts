// A small in-memory rate limiter for the sign-in endpoint.
//
// Insurance, not the control. A token carries 256 bits of entropy, so guessing
// one is not a realistic attack whatever the request rate — the limiter exists
// to stop a broken client or a crawler hammering the database with lookups,
// and to make a genuine attempt visible in the logs.
//
// In-memory on purpose. Each Functions worker keeps its own counter, so with N
// workers the effective limit is N times higher — which is fine for insurance
// and not fine for a real control. If this ever needs to be a real control it
// belongs in the database or a shared cache, and this comment is the marker
// for that decision.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export function rateLimit(
  key: string,
  { limit, windowMs, now = Date.now() }: { limit: number; windowMs: number; now?: number },
): RateLimitResult {
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic sweep: without it a long-running worker accumulates a
    // bucket per IP that ever connected.
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Best-effort client identity. Behind Static Web Apps the real address is in
 * x-forwarded-for; the first entry is the client, the rest are proxies.
 *
 * Spoofable by anyone who can set the header, which is exactly why this is
 * insurance rather than a control.
 */
export function clientKey(headers: Record<string, string | undefined>): string {
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headers['x-client-ip'] ?? headers['remote-address'] ?? 'unknown';
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear();
}
