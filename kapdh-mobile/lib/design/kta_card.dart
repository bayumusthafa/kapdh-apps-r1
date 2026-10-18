import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../app/theme/kapdh_tokens.dart';
import '../core/format/formatters.dart';
import 'brand_header.dart';
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
    // Kontrak C2: `cohort` dan `graduation_year` wajib; profesi tampil bila ada, selain itu tahun lulus (PRD 3.5).
    final detail = card.professionLabel ?? 'Lulus ${card.graduationYear}';
    final cohort = 'Angkatan ${card.cohort}';
    final expiresAt = card.expiresAt;
    final validity = switch (card.statusLabel) {
      MemberCardStatus.inactive => 'Berlaku sampai: belum aktif',
      MemberCardStatus.expired when expiresAt != null => 'Berakhir ${formatDateNumeric(expiresAt)}',
      _ when expiresAt != null => 'Berlaku sampai ${formatDateNumeric(expiresAt)}',
      _ => 'Berlaku sampai: belum aktif',
    };
    return KtaCardData(
      fullName: card.fullName,
      subtitle: '$cohort | $detail',
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

/// Kartu Tanda Anggota digital (prototipe layar 6, 7; guideline hal. 6; desain KTA v2): gradasi hijau gelap berpita
/// gelombang, kepala logo + "KELUARGA ALUMNI / PESANTREN DAREL HIKMAH" + "KTA DIGITAL", garis pemisah, avatar dan nama
/// selebar kartu, lalu kolom data (kode angkatan, nomor anggota, kota) berdampingan dengan QR atau kotak QR tertutup,
/// dan masa berlaku.
///
/// Nama SELALU di barisnya sendiri di atas QR sehingga nama panjang tidak pernah terhalang QR: ukuran hurufnya turun
/// bertahap (24 sampai 18) sampai muat dua baris. QR berukuran 38 % lebar isi kartu (96 sampai 128 px) agar kolom data
/// tetap lega di layar sempit dan teks besar.
class KtaCard extends StatelessWidget {
  const KtaCard({super.key, required this.data});

  final KtaCardData data;

  static const double _padding = 18;
  static const _nameSizes = [24.0, 22.0, 20.0, 18.0];

  /// Ukuran huruf nama terbesar yang muat dua baris pada lebar [maxWidth].
  static double nameFontSize(String name, double maxWidth, TextScaler scaler) {
    for (final size in _nameSizes) {
      final painter = TextPainter(
        text: TextSpan(text: name, style: _nameStyle(size)),
        maxLines: 2,
        textDirection: TextDirection.ltr,
        textScaler: scaler,
      )..layout(maxWidth: maxWidth);
      final fits = !painter.didExceedMaxLines;
      painter.dispose();
      if (fits) return size;
    }
    return _nameSizes.last;
  }

  static TextStyle _nameStyle(double size) =>
      TextStyle(fontSize: size, fontWeight: FontWeight.w700, height: 1.2, color: KapdhColors.textOnDark);

  /// Sisi QR untuk lebar isi kartu [innerWidth].
  static double qrSize(double innerWidth) => (innerWidth * 0.38).clamp(96.0, KapdhComponentSize.ktaQr);

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
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          gradient: KapdhGradients.ktaCard,
          borderRadius: BorderRadius.circular(KapdhRadius.lg + 2),
          boxShadow: const [
            BoxShadow(color: Color(0x24020702), blurRadius: 8, offset: Offset(0, 4)),
            BoxShadow(color: Color(0x470E280C), blurRadius: 32, offset: Offset(0, 14)),
          ],
        ),
        child: CustomPaint(
          painter: const BrandWavePainter(),
          child: Padding(
            padding: const EdgeInsets.all(_padding),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final inner = constraints.maxWidth;
                final scaler = MediaQuery.textScalerOf(context);
                final nameSize = nameFontSize(data.fullName, inner - _Avatar.size - KapdhSpace.s3, scaler);
                final qr = qrSize(inner);
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const _CardHeader(),
                    const SizedBox(height: KapdhSpace.s3),
                    const Divider(height: 1, thickness: 1, color: Color(0x40FFFFFF)),
                    const SizedBox(height: 14),
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
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: _nameStyle(nameSize),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                data.subtitle,
                                style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.green100),
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
                                const TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.w700,
                                  color: KapdhColors.textOnDark,
                                ),
                              ),
                              const SizedBox(height: 10),
                              field(
                                'Nomor Anggota',
                                data.memberNumber,
                                const TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.w700,
                                  letterSpacing: 0.5,
                                  color: KapdhColors.textOnDark,
                                ),
                              ),
                              if (data.city != null) ...[
                                const SizedBox(height: 10),
                                field(
                                  'Kota',
                                  data.city!,
                                  const TextStyle(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w600,
                                    color: KapdhColors.textOnDark,
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(width: 14),
                        _QrBox(data: data.qrData, placeholder: data.qrPlaceholder, size: qr),
                      ],
                    ),
                    const SizedBox(height: 14),
                    Text(data.validityText, style: const TextStyle(fontSize: 12, color: KapdhExtraColors.mutedOnDark)),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

/// Kepala kartu: logo, nama perkumpulan dua baris (putih dan emas) dan label "KTA DIGITAL".
class _CardHeader extends StatelessWidget {
  const _CardHeader();

  static const _tag = Text(
    'KTA DIGITAL',
    style: TextStyle(
      fontSize: 10,
      fontWeight: FontWeight.w600,
      letterSpacing: 1.2,
      color: KapdhExtraColors.mutedOnDark,
    ),
  );

  @override
  Widget build(BuildContext context) {
    const org = TextStyle(fontSize: 13, fontWeight: FontWeight.w700, letterSpacing: 0.6, height: 1.25);
    final title = Row(
      children: [
        Image.asset('assets/logo-kapdh.png', width: 48, height: 48),
        const SizedBox(width: KapdhSpace.s3),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('KELUARGA ALUMNI', style: org.copyWith(color: KapdhColors.textOnDark)),
              Text('PESANTREN DAREL HIKMAH', style: org.copyWith(color: KapdhColors.accent)),
            ],
          ),
        ),
      ],
    );
    // Teks diperbesar: label di barisnya sendiri. Ukuran normal: label di pojok kanan atas sejajar baris pertama
    // ("KELUARGA ALUMNI" lebih pendek), sehingga "PESANTREN DAREL HIKMAH" tetap satu baris di layar 360 dp.
    final large = MediaQuery.textScalerOf(context).scale(13) > 13 * 1.15;
    if (large) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Align(alignment: AlignmentDirectional.centerEnd, child: _tag),
          const SizedBox(height: KapdhSpace.s1),
          title,
        ],
      );
    }
    return Stack(
      children: [
        title,
        const PositionedDirectional(top: 8, end: 0, child: _tag),
      ],
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.name, this.image});

  final String name;
  final ImageProvider? image;
  static const double size = 56;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
        color: KapdhColors.green50,
        image: image == null ? null : DecorationImage(image: image!, fit: BoxFit.cover),
      ),
      child: image == null
          ? Text(
              initialsOf(name),
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: KapdhColors.primary),
            )
          : null,
    );
  }
}

class _QrBox extends StatelessWidget {
  const _QrBox({required this.data, required this.placeholder, required this.size});

  final String? data;
  final String placeholder;
  final double size;

  @override
  Widget build(BuildContext context) {
    final value = data;
    if (value != null) {
      return Container(
        width: size,
        height: size,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: KapdhColors.surface, borderRadius: BorderRadius.circular(14)),
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
      constraints: BoxConstraints(minHeight: size),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: KapdhExtraColors.qrPlaceholderFill,
        border: Border.all(color: KapdhExtraColors.qrPlaceholderBorder),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          // Gembok emas 34 px (prototipe layar 6): QR terkunci sampai KTA aktif atau tersinkron.
          const ExcludeSemantics(child: Icon(Icons.lock_outline, size: 34, color: KapdhColors.accent)),
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
