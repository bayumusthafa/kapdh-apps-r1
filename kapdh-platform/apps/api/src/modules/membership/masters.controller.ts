import { Controller, Get, HttpCode, Inject, Param } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { masterProfessions, masterSkills } from "@kapdh/database";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../core/db/types.js";
import { fieldError } from "../../core/errors/app-exception.js";
import { Audience, MemberAccess } from "../../core/guards/decorators.js";
import { DB } from "../../core/tokens.js";

type MasterItemList = components["schemas"]["MasterItemList"];
type MasterKind = components["schemas"]["MasterKind"];

const MASTER_KINDS: readonly MasterKind[] = ["professions", "skills"];

/**
 * GET /masters/{kind} (kontrak me.yaml listMasters; F-10, AC F10-4): hanya master AKTIF untuk pemilihan profil dan
 * filter direktori, urut sort_order lalu label. Master nonaktif tidak dapat dipilih baru tetapi tetap tampil sebagai
 * label historis pada profil yang sudah memakainya.
 */
@Controller("masters")
export class MastersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get(":kind")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  async list(@Param("kind") kind: string): Promise<MasterItemList> {
    if (!(MASTER_KINDS as readonly string[]).includes(kind))
      throw fieldError("kind", "Jenis master harus professions atau skills.");
    const items =
      kind === "professions"
        ? await this.db
            .select({ id: masterProfessions.id, label: masterProfessions.label })
            .from(masterProfessions)
            .where(eq(masterProfessions.active, true))
            .orderBy(asc(masterProfessions.sortOrder), asc(masterProfessions.label), asc(masterProfessions.id))
        : await this.db
            .select({ id: masterSkills.id, label: masterSkills.label })
            .from(masterSkills)
            .where(eq(masterSkills.active, true))
            .orderBy(asc(masterSkills.sortOrder), asc(masterSkills.label), asc(masterSkills.id));
    return { items: items.map((item) => ({ id: item.id, label: item.label, active: true })) };
  }
}
