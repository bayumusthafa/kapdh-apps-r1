import { Module } from "@nestjs/common";
import { NotificationDeliveryService } from "./delivery.service.js";
import { DevicesService } from "./devices.service.js";
import { InboxService } from "./inbox.service.js";
import { NotificationPreferencesService } from "./preferences.service.js";

/**
 * Bagian modul notifications yang DIMUAT WORKER (ARCHITECTURE §1, §4.8):
 * - `notifications.deliver` = handler topik outbox `notification.created` (email + push sesuai preferensi, kelas galat
 *   FCM; AC F13-1, F13-4);
 * - `notifications.retry` = job terjadwal setiap menit untuk pengiriman jatuh tempo (backoff, retry pengurus);
 * beserta layanan domain yang mereka pakai (token perangkat, preferensi, inbox).
 *
 * Diimpor modul notifications (job juga terdaftar di aplikasi API/uji: `jobs.runScheduled("notifications.retry")`) dan
 * oleh createWorkerContext lewat WORKER_MODULES. Tanpa controller; provider di sini tidak bergantung pada layanan khusus
 * API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege). Layanan yang juga
 * dipakai controller atau modul lain diekspor (`exports`): mis. DevicesService untuk pencabutan token saat sesi
 * berakhir (AC F13-5).
 */
@Module({
  providers: [NotificationDeliveryService, DevicesService, NotificationPreferencesService, InboxService],
  exports: [NotificationDeliveryService, DevicesService, NotificationPreferencesService, InboxService],
})
export class NotificationsJobsModule {}
