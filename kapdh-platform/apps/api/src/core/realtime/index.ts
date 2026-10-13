/**
 * Realtime Socket.IO (ARCHITECTURE §4.9): RealtimeService (emit/join/leave/disconnect setelah commit), amplop event,
 * transport gateway/emitter Redis, adapter Socket.IO untuk Fastify, dan gateway namespace /realtime.
 */
export * from "./envelope.js";
export * from "./io-adapter.js";
export * from "./realtime.gateway.js";
export * from "./realtime.service.js";
export * from "./transports.js";
