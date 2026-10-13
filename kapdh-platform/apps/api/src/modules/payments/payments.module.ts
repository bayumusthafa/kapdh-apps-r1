import { Module } from "@nestjs/common";
import { AdminAdjustmentsService } from "./admin-adjustments.service.js";
import { AdminPaymentMethodsService } from "./admin-payment-methods.service.js";
import {
  AdminAdjustmentsController,
  AdminPaymentMethodsController,
  AdminPaymentsController,
} from "./admin-payments.controller.js";
import { AdminPaymentsService } from "./admin-payments.service.js";
import { MemberPaymentsController, PaymentMethodsController } from "./member-payments.controller.js";
import { MemberPaymentsService } from "./member-payments.service.js";
import { PaymentViews } from "./payment-views.js";
import { PaymentsJobsModule } from "./payments-jobs.module.js";

/**
 * F-03, F-04 (ARCHITECTURE §4.1, §3.3): metode bayar, kutipan biaya, pembayaran anggota, bukti, antrean dan keputusan
 * admin, pencatatan iuran D13, penyesuaian. Modul tidak pernah menulis `tickets`/`alumni` langsung; efek per tipe lewat
 * PaymentHandlerRegistry (ARCHITECTURE §4.6). Pengaturan biaya (`/admin/settings/fees`) dimiliki modul admin.
 */
@Module({
  imports: [PaymentsJobsModule],
  controllers: [
    PaymentMethodsController,
    MemberPaymentsController,
    AdminPaymentsController,
    AdminAdjustmentsController,
    AdminPaymentMethodsController,
  ],
  providers: [
    PaymentViews,
    MemberPaymentsService,
    AdminPaymentsService,
    AdminAdjustmentsService,
    AdminPaymentMethodsService,
  ],
  exports: [PaymentViews],
})
export class PaymentsModule {}
