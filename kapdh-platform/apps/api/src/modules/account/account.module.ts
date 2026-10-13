import { Module } from "@nestjs/common";
import { AccountJobsModule } from "./account-jobs.module.js";

/**
 * F-14 (ARCHITECTURE §4.1): penghapusan akun di aplikasi dan web, job penghapusan, deletion ledger.
 * Diisi agen modul account (Tahap C).
 */
@Module({ imports: [AccountJobsModule] })
export class AccountModule {}
