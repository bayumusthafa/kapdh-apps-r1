import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { FastifyReply } from "fastify";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParam } from "../../core/validation/uuid-param.pipe.js";
import { validate } from "../../core/validation/validate.js";
import {
  AdminAdjustmentsService,
  cancelAdjustmentSchema,
  completeAdjustmentSchema,
  createAdjustmentSchema,
  updateAdjustmentSchema,
} from "./admin-adjustments.service.js";
import { AdminPaymentMethodsService, paymentMethodInputSchema } from "./admin-payment-methods.service.js";
import {
  adminCancelSchema,
  AdminPaymentsService,
  decisionSchema,
  recordPaymentSchema,
} from "./admin-payments.service.js";
import { PUBLIC_PAYMENT_PATHS, redactRefundDestinations } from "./payment-views.js";

type Schemas = components["schemas"];

/** Respons AdminPaymentDetail/AdminPaymentAdjustment disimpan untuk replay tanpa rekening tujuan refund (D2). */
const ADMIN_IDEMPOTENCY = { publicResponsePaths: PUBLIC_PAYMENT_PATHS, storedBody: redactRefundDestinations };

/**
 * Antrean, detail, keputusan, pembatalan dan pencatatan pembayaran oleh pengurus (kontrak admin-payments.yaml; F-04,
 * D13). Izin dievaluasi dari database setiap request (AC F15-1, F16-3); konflik kepentingan diperiksa layanan.
 */
@Controller("admin/payments")
export class AdminPaymentsController {
  constructor(private readonly payments: AdminPaymentsService) {}

  @Get()
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Schemas["AdminPaymentPage"]> {
    return this.payments.list(auth, query);
  }

  /** 201 payment baru tercatat paid; 200 payment terbuka diselesaikan di tempat (D13). */
  @Post()
  @HttpCode(201)
  @Audience("admin")
  @RequirePermission("payments.read", "payments.decide")
  @Idempotent(ADMIN_IDEMPOTENCY)
  async record(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Schemas["AdminPaymentDetail"]> {
    const result = await this.payments.record(auth, validate(recordPaymentSchema, body));
    if (!result.created) void reply.status(200);
    return result.body;
  }

  @Get("summary")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read")
  summary(): Promise<Schemas["AdminPaymentSummary"]> {
    return this.payments.summary();
  }

  @Get(":paymentId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read")
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
  ): Promise<Schemas["AdminPaymentDetail"]> {
    return this.payments.detail(auth, paymentId);
  }

  @Post(":paymentId/decision")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read", "payments.decide")
  @Idempotent(ADMIN_IDEMPOTENCY)
  decide(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
    @Body() body: unknown,
  ): Promise<Schemas["AdminPaymentDetail"]> {
    return this.payments.decide(auth, paymentId, validate(decisionSchema, body));
  }

  @Post(":paymentId/cancel")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read", "payments.decide")
  @Idempotent(ADMIN_IDEMPOTENCY)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminPaymentDetail"]> {
    const expected = parseIfMatch(ifMatch);
    return this.payments.cancel(auth, paymentId, expected, validate(adminCancelSchema, body));
  }
}

/** Penyesuaian refund/koreksi (kontrak admin-payments.yaml; PRD 3.4, 4.3, D6, D2). */
@Controller("admin")
export class AdminAdjustmentsController {
  constructor(private readonly adjustments: AdminAdjustmentsService) {}

  @Post("payments/:paymentId/adjustments")
  @HttpCode(201)
  @Audience("admin")
  @RequirePermission("payments.read", "payments.decide")
  @Idempotent(ADMIN_IDEMPOTENCY)
  create(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
    @Body() body: unknown,
  ): Promise<Schemas["AdminPaymentAdjustment"]> {
    return this.adjustments.create(auth, paymentId, validate(createAdjustmentSchema, body));
  }

  @Get("payment-adjustments")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read")
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<Schemas["AdminPaymentAdjustmentPage"]> {
    return this.adjustments.list(auth, query);
  }

  @Get("payment-adjustments/:adjustmentId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read")
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param("adjustmentId", UuidParam) adjustmentId: string,
  ): Promise<Schemas["AdminPaymentAdjustment"]> {
    return this.adjustments.detail(auth, adjustmentId);
  }

  @Patch("payment-adjustments/:adjustmentId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read", "payments.decide")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("adjustmentId", UuidParam) adjustmentId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminPaymentAdjustment"]> {
    const expected = parseIfMatch(ifMatch);
    return this.adjustments.update(auth, adjustmentId, expected, validate(updateAdjustmentSchema, body));
  }

  @Post("payment-adjustments/:adjustmentId/complete")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read", "payments.decide")
  @Idempotent(ADMIN_IDEMPOTENCY)
  complete(
    @CurrentAuth() auth: AuthContext,
    @Param("adjustmentId", UuidParam) adjustmentId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminPaymentAdjustment"]> {
    const expected = parseIfMatch(ifMatch);
    return this.adjustments.complete(auth, adjustmentId, expected, validate(completeAdjustmentSchema, body));
  }

  @Post("payment-adjustments/:adjustmentId/cancel")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("payments.read", "payments.decide")
  @Idempotent(ADMIN_IDEMPOTENCY)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param("adjustmentId", UuidParam) adjustmentId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminPaymentAdjustment"]> {
    const expected = parseIfMatch(ifMatch);
    return this.adjustments.cancel(auth, adjustmentId, expected, validate(cancelAdjustmentSchema, body));
  }
}

/**
 * Metode bayar (kontrak admin-payments.yaml; F-15, AC F15-3, F15-4): settings.manage; ubah/hapus wajib If-Match dan
 * tercatat di audit. Tanpa reautentikasi sejak keputusan PO 2026-10-15 (ADR-025).
 */
@Controller("admin/payment-methods")
export class AdminPaymentMethodsController {
  constructor(private readonly methods: AdminPaymentMethodsService) {}

  @Get()
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("settings.manage")
  list(@Query() query: unknown): Promise<Schemas["AdminPaymentMethodPage"]> {
    return this.methods.list(query);
  }

  @Post()
  @HttpCode(201)
  @Audience("admin")
  @RequirePermission("settings.manage")
  @Idempotent({ publicResponsePaths: ["account_number"] })
  create(@Body() body: unknown): Promise<Schemas["AdminPaymentMethod"]> {
    return this.methods.create(validate(paymentMethodInputSchema, body));
  }

  @Get(":methodId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("settings.manage")
  detail(@Param("methodId", UuidParam) methodId: string): Promise<Schemas["AdminPaymentMethod"]> {
    return this.methods.get(methodId);
  }

  @Put(":methodId")
  @HttpCode(200)
  @Audience("admin")
  @RequirePermission("settings.manage")
  update(
    @Param("methodId", UuidParam) methodId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["AdminPaymentMethod"]> {
    const expected = parseIfMatch(ifMatch);
    return this.methods.update(methodId, expected, validate(paymentMethodInputSchema, body));
  }

  @Delete(":methodId")
  @HttpCode(204)
  @Audience("admin")
  @RequirePermission("settings.manage")
  async remove(
    @Param("methodId", UuidParam) methodId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ): Promise<void> {
    const expected = parseIfMatch(ifMatch);
    await this.methods.delete(methodId, expected);
  }
}
