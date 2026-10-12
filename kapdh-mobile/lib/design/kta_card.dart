import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../app/theme/kapdh_tokens.dart';
import '../core/format/formatters.dart';
import 'design_constants.dart';
import 'kapdh_button.dart';
import 'status_badge.dart';

/// Data tampilan KTA (F-05). Nilai berasal dari GET /me/card atau cache offline; klien tidak menghitung status,
/// nomor maupun QR (PRD 2.2, 3.5).
@immutable
class KtaCardData {
  const KtaCardData({
    required this.fullName,
    required this.subtitle,
    required this.cohortCode,
    required this.memberNumber,
    required this.validityText,
    this.city,
    this.avatar,
    this.qrData,
    this.qrPlaceholder = 'QR muncul setelah KTA aktif',
  });

  /// Dari [MemberCard]. QR hanya ditampilkan untuk kartu aktif yang token QR-nya masih berlaku ([qrUsable]);
  /// verifikasi tetap memakai status server (AC F05-4, F06-*).
  factory KtaCardData.fromMemberCard(MemberCard card, {bool qrUsable = true, ImageProvider? avatar}) {
    final active = card.statusLabel == MemberCardStatus.active || card.statusLabel == MemberCardStatus.expiring;
    final qr = card.qr;
    final showQr = active && qr != null && qrUsable;
    final detail = card.professionLabel ?? (card.graduationYear != null ? 'Lulus ${card.graduationYear}' : null);
    final cohort = card.cohort != null ? 'Angkatan ${card.cohort}' : card.cohortCode;
    final expiresAt = card.expiresAt;
    final validity = switch (card.statusLabel) {
      MemberCardStatus.inactive => 'Berlaku sampai: belum aktif',
      MemberCardStatus.expired when expiresAt != null => 'Berakhir ${formatDateNumeric(expiresAt)}',
      _ when expiresAt != null => 'Berlaku sampai ${formatDateNumeric(expiresAt)}',
      _ => 'Berlaku sampai: belum aktif',
    };
    return KtaCardData(
      fullName: card.fullName,
      subtitle: detail == null ? cohort : '$cohort | $detail',
      cohortCode: card.cohortCode,
      memberNumber: card.memberNumber,
      city: card.city,
      avatar: avatar,
      validityText: validity,
      qrData: showQr ? qr.url : null,
      qrPlaceholder: switch (card.statusLabel) {
        MemberCardStatus.inactive => 'QR muncul setelah KTA aktif',
        MemberCardStatus.expired => 'QR aktif kembali setelah perpanjangan',
        MemberCardStatus.suspended => 'QR tidak tersedia',
        _ when active => 'Sinkronkan untuk memperbarui QR',
        _ => 'QR tidak tersedia',
      },
    );
  }

  final String fullName;

  /// Baris kecil di bawah nama, mis. "Angkatan 29 | Guru Bahasa Arab".
  final String subtitle;

  /// Mis. "KAPDH 29".
  final String cohortCode;
  final String memberNumber;
  final String? city;
  final ImageProvider? avatar;

  /// Mis. "Berlaku sampai 13/10/2027" atau "Berlaku sampai: belum aktif".
  final String validityText;

  /// Isi QR (URL verifikasi bertanda tangan server); null = kotak QR tertutup dengan [qrPlaceholder].
  final String? qrData;
  final String qrPlaceholder;
}

/// Kartu Tanda Anggota digital (prototipe layar 6, 7; guideline hal. 6): gradasi hijau gelap, nama emas, kode
/// angkatan, nomor anggota, kota, QR atau kotak QR tertutup, dan masa berlaku.
class KtaCard extends StatelessWidget {
  const KtaCard({super.key, required this.data});

  final KtaCardData data;

  @override
  Widget build(BuildContext context) {
    const label = TextStyle(fontSize: KapdhFontSize.overline, color: KapdhExtraColors.mutedOnDark);
    Widget field(String title, String value, TextStyle style) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(title, style: label),
        const SizedBox(height: 1),
        Text(value, style: style),
      ],
    );

    final semantics = [
      'Kartu Tanda Anggota',
      data.fullName,
      data.subtitle,
      'Kode angkatan ${data.cohortCode}',
      'Nomor anggota ${data.memberNumber}',
      if (data.city != null) 'Kota ${data.city}',
      data.validityText,
      data.qrData != null ? 'QR verifikasi tersedia' : data.qrPlaceholder,
    ].join('. ');

    return Semantics(
      container: true,
      label: semantics,
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(gradient: KapdhGradients.ktaCard, borderRadius: BorderRadius.circular(16)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _Avatar(name: data.fullName, image: data.avatar),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        data.fullName,
                        style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: KapdhColors.accent),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        data.subtitle,
                        style: const TextStyle(fontSize: KapdhFontSize.overline, color: KapdhColors.green100),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      field(
                        'Kode Angkatan',
                        data.cohortCode,
                        const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: KapdhColors.textOnDark),
                      ),
                      const SizedBox(height: 10),
                      field(
                        'Nomor anggota',
                        data.memberNumber,
                        const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: KapdhColors.textOnDark),
                      ),
                      if (data.city != null) ...[
                        const SizedBox(height: 10),
                        field('Kota', data.city!, const TextStyle(fontSize: 13, color: KapdhColors.textOnDark)),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 14),
                _QrBox(data: data.qrData, placeholder: data.qrPlaceholder),
              ],
            ),
            const SizedBox(height: 14),
            Text(data.validityText, style: const TextStyle(fontSize: 12, color: KapdhExtraColors.mutedOnDark)),
          ],
        ),
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.name, this.image});

  final String name;
  final ImageProvider? image;
  static const double size = 52;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: KapdhColors.green100,
        image: image == null ? null : DecorationImage(image: image!, fit: BoxFit.cover),
      ),
      child: image == null
          ? Text(
              initialsOf(name),
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: KapdhColors.primary),
            )
          : null,
    );
  }
}

class _QrBox extends StatelessWidget {
  const _QrBox({required this.data, required this.placeholder});

  final String? data;
  final String placeholder;

  @override
  Widget build(BuildContext context) {
    const size = KapdhComponentSize.ktaQr;
    final value = data;
    if (value != null) {
      return Container(
        width: size,
        height: size,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: KapdhColors.surface, borderRadius: BorderRadius.circular(12)),
        child: QrImageView(
          key: const ValueKey('kta-qr'),
          data: value,
          padding: EdgeInsets.zero,
          backgroundColor: KapdhColors.surface,
          eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: KapdhColors.surfaceDark),
          dataModuleStyle: const QrDataModuleStyle(
            dataModuleShape: QrDataModuleShape.square,
            color: KapdhColors.surfaceDark,
          ),
          semanticsLabel: 'QR verifikasi KTA',
        ),
      );
    }
    return Container(
      key: const ValueKey('kta-qr-placeholder'),
      width: size,
      constraints: const BoxConstraints(minHeight: size),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: KapdhExtraColors.qrPlaceholderFill,
        border: Border.all(color: KapdhExtraColors.qrPlaceholderBorder),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.qr_code_2, size: 32, color: KapdhExtraColors.mutedOnDark),
          const SizedBox(height: KapdhSpace.s2),
          Text(
            placeholder,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: KapdhFontSize.overline, height: 1.35, color: KapdhColors.textOnDark),
          ),
        ],
      ),
    );
  }
}

/// KTA ringkas pada layar Biaya KTA (prototipe layar 2): nama emas, angkatan, badge status dan nomor anggota.
class KtaMiniCard extends StatelessWidget {
  const KtaMiniCard({
    super.key,
    required this.fullName,
    required this.subtitle,
    required this.memberNumber,
    required this.status,
  });

  final String fullName;
  final String subtitle;
  final String memberNumber;
  final StatusBadgeStyle status;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(KapdhSpace.s4),
      decoration: BoxDecoration(gradient: KapdhGradients.ktaCard, borderRadius: BorderRadius.circular(KapdhRadius.lg)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      fullName,
                      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: KapdhColors.accent),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: const TextStyle(fontSize: KapdhFontSize.overline, color: KapdhColors.green100),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: KapdhSpace.s3),
              Flexible(child: StatusBadge(status)),
            ],
          ),
          const SizedBox(height: 10),
          const Text(
            'Nomor anggota',
            style: TextStyle(fontSize: KapdhFontSize.overline, color: KapdhExtraColors.mutedOnDark),
          ),
          const SizedBox(height: 2),
          Text(
            memberNumber,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.5,
              color: KapdhColors.textOnDark,
            ),
          ),
        ],
      ),
    );
  }
}

/// Kartu status di bawah KTA (prototipe layar 6, 7; guideline hal. 6): badge, keterangan dan satu aksi
/// ("Bayar", "Perpanjang", "Sinkronkan").
class StatusActionCard extends StatelessWidget {
  const StatusActionCard({
    super.key,
    required this.status,
    required this.message,
    this.actionLabel,
    this.onAction,
    this.outlinedAction = false,
    this.busy = false,
  });

  final StatusBadgeStyle status;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  /// Aksi bergaris (mis. "Sinkronkan" saat offline) alih-alih hijau penuh.
  final bool outlinedAction;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final label = actionLabel;
    final info = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        StatusBadge(status),
        const SizedBox(height: 6),
        Text(
          message,
          style: const TextStyle(fontSize: KapdhFontSize.caption, height: 1.45, color: KapdhColors.textMuted),
        ),
      ],
    );
    Widget? action;
    if (label != null) {
      action = outlinedAction
          ? KapdhButton.outlined(label: label, onPressed: onAction, busy: busy, expand: false)
          : KapdhButton.solid(label: label, onPressed: onAction, busy: busy, expand: false);
    }
    // Teks diperbesar (N-11): aksi pindah ke bawah keterangan agar tidak saling himpit.
    final stacked = MediaQuery.textScalerOf(context).scale(KapdhFontSize.body) > KapdhFontSize.body * 1.3;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: 14),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: action == null
          ? Align(alignment: Alignment.centerLeft, child: info)
          : stacked
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                info,
                const SizedBox(height: KapdhSpace.s3),
                action,
              ],
            )
          : Row(
              children: [
                Expanded(child: info),
                const SizedBox(width: KapdhSpace.s3),
                action,
              ],
            ),
    );
  }
}
