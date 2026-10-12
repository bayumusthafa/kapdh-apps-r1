import { Module } from "@nestjs/common";
import { MeController } from "./me.controller.js";

/**
 * F-05, F-06, F-07: /me, profil, kartu (KTA), periode keanggotaan, master (baca), verifikasi KTA publik, pengingat
 * kedaluwarsa (ARCHITECTURE §4.1). Fungsi murni nomor anggota/periode/effective_status ada di core/membership.
 */
@Module({
  controllers: [MeController],
})
export class MembershipModule {}
