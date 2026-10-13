import { Redis } from "ioredis";

/**
 * Klien Redis (PRD 5.1: antrean BullMQ, rate limit, adapter realtime). Hanya dibuat bila REDIS_URL diisi; tanpa
 * REDIS_URL (development/test di mesin tanpa Redis) seluruh komponen memakai implementasi memori.
 */
export type RedisClient = Redis;

export function createRedis(url: string, connectionName: string): Redis {
  return new Redis(url, {
    connectionName,
    // Perintah gagal cepat saat Redis putus agar request tidak menggantung; rate limit mengembalikan galat 5xx.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
}
