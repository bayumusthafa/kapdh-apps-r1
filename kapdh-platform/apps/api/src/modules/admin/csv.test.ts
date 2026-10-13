import { describe, expect, it } from "vitest";
import {
  AUDIT_CSV_HEADER,
  auditCsvRow,
  csvCell,
  csvRow,
  isPrivateExportKey,
  MASKED_VALUE,
  maskPrivateFields,
  neutralizeFormula,
} from "./csv.js";

describe("AC F17-3: netralisasi formula CSV", () => {
  it.each(["=SUM(A1:A2)", "+62812", "-1", "@cmd", "\tisi", "\risi", "=HYPERLINK(\"http://x\")"])(
    "AC F17-3: sel diawali karakter formula %j diberi awalan apostrof",
    (value) => {
      expect(neutralizeFormula(value)).toBe(`'${value}`);
      expect(csvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
    },
  );

  it.each(["payment.approved", "Alumni 09", " =spasi di depan", "", "0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e68"])(
    "AC F17-3: sel aman %j tidak diubah",
    (value) => {
      expect(neutralizeFormula(value)).toBe(value);
    },
  );

  it("AC F17-3: kutipan RFC 4180, null menjadi sel kosong, baris diakhiri CRLF", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell('kata "kutip", koma')).toBe('"kata ""kutip"", koma"');
    expect(csvCell(42)).toBe('"42"');
    expect(csvRow(["a", null, "=b"])).toBe('"a",,"\'=b"\r\n');
  });
});

describe("AC F17-3: penyamaran kolom privat dan secret pada ekspor", () => {
  it.each([
    "email",
    "login_email",
    "Email",
    "phone",
    "contact_phone",
    "whatsapp",
    "support_whatsapp",
    "social_instagram",
    "address",
    "home_address",
    "birth_date",
    "birth_place",
    "date_of_birth",
    "city",
    "avatar_file_id",
    "avatarUrl",
    "photo_id",
    "proof_file_id",
    "ip",
    "ip_address",
    "user_agent",
    "device_name",
    "password",
    "passwordHash",
    "invite_token_hash",
    "otp_code",
    "refresh_token",
    "client_secret",
    "backup_codes",
    "totp_secret",
    "nik",
    "ktp",
    "account_number",
    "refundAccountNumber",
  ])("AC F17-3: kunci %s dianggap privat", (key) => {
    expect(isPrivateExportKey(key)).toBe(true);
  });

  it.each(["display_name", "role", "permissions", "status", "amount", "file_id", "row_count", "version", "reason"])(
    "AC F17-3: kunci %s tidak disamarkan",
    (key) => {
      expect(isPrivateExportKey(key)).toBe(false);
    },
  );

  it("AC F17-3: penelusuran rekursif objek dan array; nama kunci dan null tetap ada", () => {
    const masked = maskPrivateFields({
      display_name: "Admin Satu",
      email: "admin@contoh.test",
      phone: null,
      value: { support: { email: "bantuan@contoh.test", whatsapp: "+6281234567890" }, version: 2 },
      items: [{ socialX: "@alumni", city: "Bandung", label: "aman" }, "teks"],
      nested: { deeper: { password_hash: "$2b$abc", ok: true } },
    });
    expect(masked).toEqual({
      display_name: "Admin Satu",
      email: MASKED_VALUE,
      phone: null,
      value: { support: { email: MASKED_VALUE, whatsapp: MASKED_VALUE }, version: 2 },
      items: [{ socialX: MASKED_VALUE, city: MASKED_VALUE, label: "aman" }, "teks"],
      nested: { deeper: { password_hash: MASKED_VALUE, ok: true } },
    });
  });

  it("AC F17-3: objek bersarang di bawah kunci privat disamarkan seluruhnya", () => {
    expect(maskPrivateFields({ address: { street: "Jl. Uji", zip: "40111" } })).toEqual({ address: MASKED_VALUE });
  });
});

describe("AC F17-3, F17-4: baris CSV audit", () => {
  it("AC F17-3: header sesuai urutan kontrak", () => {
    expect([...AUDIT_CSV_HEADER]).toEqual([
      "created_at",
      "action",
      "entity_type",
      "entity_id",
      "effective_role",
      "actor_admin_id",
      "actor_user_id",
      "actor_name",
      "request_id",
      "reason",
      "before",
      "after",
    ]);
  });

  it("AC F17-3: before/after disamarkan lalu diserialisasi JSON; alasan berformula dinetralkan", () => {
    const line = auditCsvRow({
      createdAt: new Date("2026-10-12T03:00:00.000Z"),
      action: "admin.updated",
      entityType: "admin",
      entityId: "0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e68",
      effectiveRole: "super_admin",
      actorAdminId: "0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e69",
      actorUserId: null,
      actorName: "@Super",
      requestId: "req-1",
      reason: "=cmd|' /C calc'!A0",
      before: { email: "lama@contoh.test", role: "admin" },
      after: null,
    });
    expect(line.endsWith("\r\n")).toBe(true);
    expect(line).toContain(`"'@Super"`);
    expect(line).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(line).not.toContain("lama@contoh.test");
    expect(line).toContain('"{""email"":""[disembunyikan]"",""role"":""admin""}"');
    // after null = sel kosong di akhir baris.
    expect(line.endsWith(",\r\n")).toBe(true);
  });
});
