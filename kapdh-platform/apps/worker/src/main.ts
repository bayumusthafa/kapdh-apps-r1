import { loadServerEnv } from "@kapdh/config";

/**
 * Kerangka worker. Irisan berikutnya menambahkan dispatcher outbox (outbox_events -> BullMQ dengan dedup key),
 * pengiriman email/push dengan retry terklasifikasi, expiry reservasi, pengingat, cleanup unggahan dan deletion job.
 */
const env = loadServerEnv();
console.log(JSON.stringify({ level: "info", msg: "worker siap", env: env.NODE_ENV }));
