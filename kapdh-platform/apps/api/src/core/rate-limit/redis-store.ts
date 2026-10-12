import { randomBytes } from "node:crypto";
import type { RedisClient } from "../adapters/redis.js";
import { MAX_HITS_PER_KEY, type RateLimitStore, storageKey } from "./store.js";

/**
 * Sliding window di Redis sorted set (PRD 5.1: rate limit lintas replica). Setiap operasi satu skrip Lua sehingga
 * pemangkasan, penghitungan, dan pencatatan atomik walau banyak instance API bersamaan. TTL kunci = jendela.
 */
const CHECK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local record = ARGV[4] == '1'
local member = ARGV[5]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  if record then
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
  end
  return 0
end
local pivot = redis.call('ZRANGE', key, count - limit, count - limit, 'WITHSCORES')
local wait = tonumber(pivot[2]) + window - now
if wait < 1 then wait = 1 end
return wait
`;

const HIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
local cap = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
redis.call('ZADD', key, now, member)
local count = redis.call('ZCARD', key)
if count > cap then redis.call('ZREMRANGEBYRANK', key, 0, count - cap - 1) end
redis.call('PEXPIRE', key, window)
return count
`;

function member(nowMs: number): string {
  return `${nowMs}-${randomBytes(6).toString("hex")}`;
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisClient) {}

  private async check(key: string, limit: number, windowMs: number, nowMs: number, record: boolean) {
    const result = await this.redis.eval(
      CHECK_SCRIPT,
      1,
      storageKey(key),
      String(nowMs),
      String(windowMs),
      String(limit),
      record ? "1" : "0",
      member(nowMs),
    );
    return Number(result);
  }

  consume(key: string, limit: number, windowMs: number, nowMs: number): Promise<number> {
    return this.check(key, limit, windowMs, nowMs, true);
  }

  peek(key: string, limit: number, windowMs: number, nowMs: number): Promise<number> {
    return this.check(key, limit, windowMs, nowMs, false);
  }

  async hit(key: string, windowMs: number, nowMs: number): Promise<number> {
    const count = await this.redis.eval(
      HIT_SCRIPT,
      1,
      storageKey(key),
      String(nowMs),
      String(windowMs),
      member(nowMs),
      String(MAX_HITS_PER_KEY),
    );
    return Number(count);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(storageKey(key));
  }
}
