import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { FastifyReply } from "fastify";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParam } from "../../core/validation/uuid-param.pipe.js";
import { validate } from "../../core/validation/validate.js";
import {
  cancelPaymentSchema,
  changeMethodSchema,
  createPaymentSchema,
  MemberPaymentsService,
  refundDestinationSchema,
  submitProofSchema,
} from "./member-payments.service.js";
import { PUBLIC_METHOD_PATHS } from "./payment-views.js";

type Schemas = components["schemas"];

/** Metode bayar aktif untuk layar instruksi bayar dan pilihan metode tiket (F-03, D13). */
@Controller("payment-methods")
export class PaymentMethodsController {
  constructor(private readonly payments: MemberPaymentsService) {}

  @Get()
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  list(): Promise<Schemas["PaymentMethodList"]> {
    return this.payments.listMethods();
  }
}

/**
 * Pembayaran milik anggota (kontrak payments.yaml; F-03, F-07, F-09 sisi pembayaran, D4, D6, D13). Riwayat dan detail
 * terbuka untuk semua effective_status (`any`); membuat dan mengubah pembayaran hanya `nonsuspended` (PRD 2.2).
 */
@Controller("me")
export class MemberPaymentsController {
  constructor(private readonly payments: MemberPaymentsService) {}

  @Get("fees")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  fees(@CurrentAuth() auth: AuthContext): Promise<Schemas["MyFeeQuotes"]> {
    return this.payments.fees(auth);
  }

  @Get("payments")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Schemas["PaymentPage"]> {
    return this.payments.list(auth, query);
  }

  /** 201 untuk instruksi baru, 200 untuk payment nonterminal jenis sama yang sudah ada (AC F03-1). */
  @Post("payments")
  @HttpCode(201)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  @Idempotent({ publicResponsePaths: PUBLIC_METHOD_PATHS })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Schemas["PaymentDetail"]> {
    const result = await this.payments.create(auth, validate(createPaymentSchema, body));
    if (!result.created) void reply.status(200);
    return result.body;
  }

  @Get("payments/:paymentId")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
  ): Promise<Schemas["PaymentDetail"]> {
    return this.payments.detail(auth, paymentId);
  }

  @Put("payments/:paymentId/method")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  changeMethod(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["PaymentDetail"]> {
    const expected = parseIfMatch(ifMatch);
    return this.payments.changeMethod(auth, paymentId, expected, validate(changeMethodSchema, body));
  }

  @Put("payments/:paymentId/proof")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  @Idempotent({ publicResponsePaths: PUBLIC_METHOD_PATHS })
  submitProof(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
    @Body() body: unknown,
  ): Promise<Schemas["PaymentDetail"]> {
    return this.payments.submitProof(auth, paymentId, validate(submitProofSchema, body));
  }

  @Post("payments/:paymentId/cancel")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  @Idempotent({ publicResponsePaths: PUBLIC_METHOD_PATHS })
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["PaymentDetail"]> {
    const expected = parseIfMatch(ifMatch);
    return this.payments.cancel(auth, paymentId, expected, validate(cancelPaymentSchema, body));
  }

  @Put("payments/:paymentId/adjustments/:adjustmentId/refund-destination")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  setRefundDestination(
    @CurrentAuth() auth: AuthContext,
    @Param("paymentId", UuidParam) paymentId: string,
    @Param("adjustmentId", UuidParam) adjustmentId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["PaymentDetail"]> {
    const expected = parseIfMatch(ifMatch);
    return this.payments.setRefundDestination(
      auth,
      paymentId,
      adjustmentId,
      expected,
      validate(refundDestinationSchema, body),
    );
  }
}
