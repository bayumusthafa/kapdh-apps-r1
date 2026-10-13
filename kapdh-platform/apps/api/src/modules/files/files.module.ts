import { Module } from "@nestjs/common";
import { FilesJobsModule } from "./files-jobs.module.js";
import { FilesController } from "./files.controller.js";

/**
 * Unggahan /files dan akses bertanda tangan (PRD 2.5, 5.4, N-10): controller tipis di atas FilesService core
 * (ARCHITECTURE §4.1). Job `files.cleanup-temp` didaftarkan FilesService (core) sehingga worker menjalankannya.
 */
@Module({ imports: [FilesJobsModule], controllers: [FilesController] })
export class FilesModule {}
