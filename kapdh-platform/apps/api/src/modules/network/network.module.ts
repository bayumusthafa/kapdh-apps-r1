import { Module } from "@nestjs/common";
import { AdminMastersController } from "./admin-masters.controller.js";
import { DirectoryController } from "./directory.controller.js";
import { DirectoryService } from "./directory.service.js";
import { MastersService } from "./masters.service.js";

/**
 * F-10 dan F-15 master (ARCHITECTURE §4.1, §3.5): direktori dan profil anggota (hanya-baca; field tersembunyi tidak
 * ikut payload, AC F10-2), kebijakan baca avatar direktori, dan CRUD master profesi/keahlian oleh pengurus
 * (master.manage, AC F10-4). Modul ini tidak memiliki job sehingga tidak dimuat worker.
 */
@Module({
  controllers: [DirectoryController, AdminMastersController],
  providers: [DirectoryService, MastersService],
})
export class NetworkModule {}
