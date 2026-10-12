// Pembangkit katalog Dart dari @kapdh/shared: error_catalog.dart (ERROR_UI, PRD 5.2) dan status_routes.dart
// (routeForStatus, MEMBERSHIP_LABEL, PRD 2.2). Satu sumber kebenaran untuk web dan Flutter.
import { camelCase, dartString, docComment, enumMemberName } from "../names.mjs";
import { GENERATED_HEADER } from "./runtime.mjs";

/**
 * Memeriksa katalog shared terhadap enum kontrak lalu merender kedua berkas.
 * @param {import("./model.mjs").ModelRegistry} registry
 * @param {Awaited<ReturnType<typeof import("../shared-catalog.mjs").loadSharedCatalog>>} shared
 */
export function renderCatalogs(registry, shared) {
  const errorCode = registry.types.get("ErrorCode");
  const effectiveStatus = registry.types.get("EffectiveStatus");
  if (errorCode?.kind !== "enum") registry.error("skema ErrorCode (enum) wajib ada di root.yaml");
  if (effectiveStatus?.kind !== "enum") registry.error("skema EffectiveStatus (enum) wajib ada di root.yaml");
  if (errorCode?.kind !== "enum" || effectiveStatus?.kind !== "enum") return {};

  const required = [
    "ERROR_UI",
    "ERROR_UI_ACTIONS",
    "CLIENT_ERROR_UI",
    "MEMBER_ROUTES",
    "MEMBER_ROUTE_PATH",
    "MEMBERSHIP_LABEL",
    "MEMBERSHIP_LABEL_UNKNOWN",
    "routeForStatus",
  ];
  for (const name of required) {
    if (!(name in shared)) registry.error(`@kapdh/shared tidak mengekspor ${name}`);
  }
  if (registry.errors.length) return {};

  const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
  const codes = errorCode.members.map((m) => m.value);
  if (!sameSet(Object.keys(shared.ERROR_UI), codes)) {
    registry.error(
      `ERROR_UI (@kapdh/shared) tidak sama dengan ErrorCode kontrak. Kontrak: ${codes.join(", ")}; ` +
        `ERROR_UI: ${Object.keys(shared.ERROR_UI).join(", ")}`,
    );
  }
  const statuses = effectiveStatus.members.map((m) => m.value);
  if (!sameSet(Object.keys(shared.MEMBERSHIP_LABEL), statuses)) {
    registry.error("MEMBERSHIP_LABEL (@kapdh/shared) tidak mencakup tepat semua EffectiveStatus kontrak");
  }
  const actions = [...shared.ERROR_UI_ACTIONS];
  for (const [code, ui] of [...Object.entries(shared.ERROR_UI), ...Object.entries(shared.CLIENT_ERROR_UI)]) {
    if (!actions.includes(ui.action))
      registry.error(`ERROR_UI.${code}: aksi '${ui.action}' tidak ada di ERROR_UI_ACTIONS`);
  }
  for (const route of shared.MEMBER_ROUTES) {
    if (typeof shared.MEMBER_ROUTE_PATH[route] !== "string")
      registry.error(`MEMBER_ROUTE_PATH.${route} wajib ada`);
  }
  const routeOf = new Map();
  for (const status of statuses) {
    const route = shared.routeForStatus(status);
    if (!shared.MEMBER_ROUTES.includes(route))
      registry.error(`routeForStatus('${status}') = '${route}' tidak terdaftar`);
    routeOf.set(status, route);
  }
  if (registry.errors.length) return {};

  const errorUi = (ui) =>
    `const ErrorUi(action: ErrorUiAction.${enumMemberName(ui.action)}, fallbackMessage: ${dartString(ui.fallbackMessage)})`;

  const errorCatalog = `${GENERATED_HEADER}
// Katalog penanganan galat tunggal (PRD 5.2) dari packages/shared/src/errors.ts (ERROR_UI, CLIENT_ERROR_UI).

import 'package:meta/meta.dart';

import 'models.dart';

/// Perilaku UI seragam untuk setiap kode galat (PRD 4.5, 5.2).
enum ErrorUiAction {
${actions.map((a) => `  ${enumMemberName(a)}(${dartString(a)})`).join(",\n")};

  const ErrorUiAction(this.value);

  /// Nama aksi di katalog @kapdh/shared.
  final String value;
}

/// Perilaku UI dan pesan cadangan untuk satu kode galat.
@immutable
final class ErrorUi {
  const ErrorUi({required this.action, required this.fallbackMessage});

  final ErrorUiAction action;

  /// Pesan cadangan bila server tidak mengirim pesan; pesan server selalu diutamakan.
  final String fallbackMessage;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ErrorUi && other.action == action && other.fallbackMessage == fallbackMessage;

  @override
  int get hashCode => Object.hash(action, fallbackMessage);

  @override
  String toString() => 'ErrorUi(\${action.value})';
}

/// Kegagalan sisi klien yang tidak berasal dari body Error server (PRD 4.5): jaringan putus/timeout
/// ([network], tidak pernah membuat pengguna keluar) dan respons/kode yang tidak dikenali ([unknown]).
enum ClientErrorCode {
${Object.keys(shared.CLIENT_ERROR_UI)
  .map((c) => `  ${camelCase(c.toLowerCase())}(${dartString(c)})`)
  .join(",\n")};

  const ClientErrorCode(this.value);

  final String value;
}

/// Perilaku UI untuk [code] dari server. Kode yang belum dikenal versi SDK ini ([ErrorCode.unknown])
/// memakai perilaku [ClientErrorCode.unknown].
ErrorUi errorUiFor(ErrorCode code) => switch (code) {
${errorCode.members
  .map((m) => `      ErrorCode.${m.name} => ${errorUi(shared.ERROR_UI[m.value])},`)
  .join("\n")}
      ErrorCode.unknown => clientErrorUi(ClientErrorCode.unknown),
    };

/// Perilaku UI untuk kegagalan sisi klien.
ErrorUi clientErrorUi(ClientErrorCode code) => switch (code) {
${Object.entries(shared.CLIENT_ERROR_UI)
  .map(([c, ui]) => `      ClientErrorCode.${camelCase(c.toLowerCase())} => ${errorUi(ui)},`)
  .join("\n")}
    };
`;

  const routes = [...shared.MEMBER_ROUTES];
  const statusRoutes = `${GENERATED_HEADER}
// Rute awal dan label status anggota (PRD 2.2, 4.5) dari packages/shared/src/status.ts.

import 'models.dart';

/// Rute awal aplikasi anggota beserta path go_router (ARCHITECTURE §8.4). Server tetap menegakkan izin.
enum MemberRoute {
${routes.map((r) => `  ${enumMemberName(r)}(${dartString(r)}, ${dartString(shared.MEMBER_ROUTE_PATH[r])})`).join(",\n")};

  const MemberRoute(this.value, this.path);

  /// Nama rute di katalog @kapdh/shared.
  final String value;

  /// Path go_router di aplikasi Flutter.
  final String path;
}

${docComment(
  "Rute awal untuk effective_status dari GET /me (PRD 2.2). Mengembalikan `null` untuk status yang belum dikenal " +
    "versi aplikasi ini; aplikasi tidak menebak akses dan meminta pembaruan aplikasi.",
)}MemberRoute? routeForStatus(EffectiveStatus status) => switch (status) {
${effectiveStatus.members
  .map((m) => `      EffectiveStatus.${m.name} => MemberRoute.${enumMemberName(routeOf.get(m.value))},`)
  .join("\n")}
      EffectiveStatus.unknown => null,
    };

/// Label status yang selalu ditampilkan bersama warna/ikon (PRD 4.5: status tidak dibedakan dengan warna saja).
String membershipLabel(EffectiveStatus status) => switch (status) {
${effectiveStatus.members
  .map((m) => `      EffectiveStatus.${m.name} => ${dartString(shared.MEMBERSHIP_LABEL[m.value])},`)
  .join("\n")}
      EffectiveStatus.unknown => ${dartString(shared.MEMBERSHIP_LABEL_UNKNOWN)},
    };
`;
  return { "error_catalog.dart": errorCatalog, "status_routes.dart": statusRoutes };
}
