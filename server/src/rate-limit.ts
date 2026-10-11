type Bucket = { stamps: number[] };

export function createRateLimiter(max: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();

  return function allow(key: string, now = Date.now()): boolean {
    const bucket = buckets.get(key) ?? { stamps: [] };
    bucket.stamps = bucket.stamps.filter((stamp) => now - stamp < windowMs);
    if (bucket.stamps.length >= max) {
      buckets.set(key, bucket);
      return false;
    }
    bucket.stamps.push(now);
    buckets.set(key, bucket);
    if (buckets.size > 5000) {
      for (const [id, value] of buckets) {
        if (value.stamps.every((stamp) => now - stamp >= windowMs)) buckets.delete(id);
      }
    }
    return true;
  };
}
