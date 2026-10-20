import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../app/theme/kapdh_focus.dart';
import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';
import '../core/format/formatters.dart';
import 'brand_header.dart';
import 'design_constants.dart';
import 'kapdh_button.dart';
import 'status_badge.dart';
import 'kapdh_icons.dart';

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
/// gelombang dengan tata letak ringkas mendekati kartu identitas landscape (sekitar 1,5 : 1 pada lebar 320). Kepala
/// logo + "KELUARGA ALUMNI / PESANTREN DAREL HIKMAH" + "KTA DIGITAL", garis pemisah, avatar dan nama selebar kartu,
/// lalu kolom data (kode angkatan dan nomor anggota bersebelahan, bertumpuk saat teks diperbesar; kota; masa berlaku)
/// berdampingan dengan QR atau kotak QR tertutup.
///
/// Nama SELALU di barisnya sendiri di atas QR sehingga nama panjang tidak pernah terhalang QR: ukuran hurufnya turun
/// bertahap (20 sampai 16) sampai muat dua baris. QR berukuran 33 % lebar isi kartu (96 sampai 112 px); batas bawah
/// 96 menjaga QR tetap mudah dipindai.
class KtaCard extends StatelessWidget {
  const KtaCard({super.key, required this.data, this.fill = false, this.onTap});

  final KtaCardData data;

  /// Mengisi ukuran yang diberikan induk (pratinjau layar penuh berproporsi KTP): isi kartu dirender pada lebar
  /// acuan [fillContentWidth] lalu diskalakan sebesar mungkin di dalam kartu.
  final bool fill;

  /// Ketukan pada kartu (membuka pratinjau layar penuh). Bila diisi, kartu juga dapat difokus keyboard/akses saklar
  /// (cincin emas) dan diaktifkan dengan Enter/Spasi; null = kartu statis yang tidak dapat difokus.
  final VoidCallback? onTap;

  /// Lebar isi acuan pada mode [fill] (isi kartu 320 dp tanpa padding).
  static const double fillContentWidth = 296;

  /// Proporsi kartu identitas ISO/IEC 7810 ID-1 (KTP): 85,6 x 54 mm.
  static const double idCardAspectRatio = 85.6 / 54;

  static const double _padding = 12;
  static const _nameSizes = [20.0, 18.0, 16.0];

  /// Ukuran huruf nama terbesar yang muat dua baris pada lebar [maxWidth]. [base] adalah gaya teks bawaan tempat nama
  /// dibangun (DefaultTextStyle: keluarga font Poppins, letterSpacing tema) agar pengukuran sama dengan [Text] yang
  /// tampil; tanpa itu nama diukur dengan font platform yang lebih sempit lalu terpotong elipsis.
  static double nameFontSize(String name, double maxWidth, TextScaler scaler, {TextStyle base = const TextStyle()}) {
    for (final size in _nameSizes) {
      final painter = TextPainter(
        text: TextSpan(text: name, style: base.merge(_nameStyle(size))),
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
      TextStyle(fontSize: size, fontWeight: FontWeight.w700, height: 1.15, color: KapdhColors.textOnDark);

  /// Sisi QR untuk lebar isi kartu [innerWidth].
  static double qrSize(double innerWidth) => (innerWidth * 0.33).clamp(96.0, 112.0);

  /// Teks diperbesar (> 115 %): ambang bersama kepala kartu dan baris data.
  static bool _largeText(TextScaler scaler) => scaler.scale(11) > 11 * 1.15;

  @override
  Widget build(BuildContext context) {
    // Minimum skala tipografi Material (labelSmall 11) untuk semua teks kartu.
    const label = TextStyle(
      fontSize: KapdhFontSize.overline,
      height: 1.2,
      letterSpacing: 0,
      color: KapdhExtraColors.mutedOnDark,
    );
    Widget field(String title, String value, TextStyle style) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(title, style: label),
        Text(value, style: style),
      ],
    );
    const value = TextStyle(fontSize: 14, fontWeight: FontWeight.w700, height: 1.25, color: KapdhColors.textOnDark);

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

    final content = CustomPaint(
      painter: const BrandWavePainter(),
      child: Padding(
        padding: const EdgeInsets.all(_padding),
        child: _fit(
          LayoutBuilder(
            builder: (context, constraints) {
              final inner = constraints.maxWidth;
              final scaler = MediaQuery.textScalerOf(context);
              final nameSize = nameFontSize(
                data.fullName,
                inner - _Avatar.size - 10,
                scaler,
                base: DefaultTextStyle.of(context).style,
              );
              final qr = qrSize(inner);
              // Teks diperbesar: kode angkatan dan nomor anggota bertumpuk agar nomor tidak terpecah di tengah
              // angka (kolom berdampingan hanya sekitar 89 dp pada teks 200 % di layar 360 dp).
              final largeText = _largeText(scaler);
              final cohortField = field('Kode Angkatan', data.cohortCode, value);
              final numberField = field('Nomor Anggota', data.memberNumber, value.copyWith(letterSpacing: 0.3));
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _CardHeader(),
                  const SizedBox(height: 6),
                  const Divider(height: 1, thickness: 1, color: Color(0x40FFFFFF)),
                  const SizedBox(height: KapdhSpace.s2),
                  Row(
                    children: [
                      _Avatar(name: data.fullName, image: data.avatar),
                      const SizedBox(width: 10),
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
                            Text(
                              data.subtitle,
                              style: const TextStyle(fontSize: 11, height: 1.3, color: KapdhColors.green100),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s2),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (largeText) ...[
                              cohortField,
                              const SizedBox(height: 6),
                              numberField,
                            ] else
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Expanded(child: cohortField),
                                  const SizedBox(width: KapdhSpace.s2),
                                  Expanded(child: numberField),
                                ],
                              ),
                            if (data.city != null) ...[
                              const SizedBox(height: 6),
                              field('Kota', data.city!, value.copyWith(fontSize: 13, fontWeight: FontWeight.w600)),
                            ],
                            const SizedBox(height: 6),
                            Text(
                              data.validityText,
                              style: const TextStyle(fontSize: 11, height: 1.3, color: KapdhExtraColors.mutedOnDark),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: KapdhSpace.s3),
                      _QrBox(data: data.qrData, placeholder: data.qrPlaceholder, size: qr),
                    ],
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );

    // [v2] Bayangan dari palet (KapdhShadowsDark.kta di mode gelap), bukan literal terang.
    final radius = BorderRadius.circular(KapdhRadius.lg);
    Widget card(Widget child) => Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        gradient: KapdhGradients.ktaCard,
        borderRadius: radius,
        boxShadow: context.kc.shadowKta,
      ),
      child: child,
    );

    final tap = onTap;
    return Semantics(
      container: true,
      label: semantics,
      excludeSemantics: true,
      button: tap != null,
      hint: tap != null ? 'Ketuk untuk tampilan layar penuh' : null,
      onTap: tap,
      // [v2] Kartu berketuk dapat difokus keyboard/akses saklar dengan cincin emas di atas tepi kartu (WCAG 2.4.7,
      // 1.4.11). Riak di atas gradasi (Material di dalam Container) tetapi di bawah gelombang dan isi; putih halus agar
      // teks dan QR tetap terbaca. Tanpa onTap kartu tetap polos: tidak dapat difokus dan tampilannya sama.
      child: tap == null
          ? card(content)
          : KapdhFocusRing(
              ring: KapdhColors.focusRingOnDark,
              radius: radius,
              builder: (onFocusChange) => card(
                Material(
                  type: MaterialType.transparency,
                  child: InkWell(
                    onTap: tap,
                    onFocusChange: onFocusChange,
                    borderRadius: radius,
                    splashColor: const Color(0x1FFFFFFF),
                    highlightColor: const Color(0x0FFFFFFF),
                    hoverColor: const Color(0x0AFFFFFF),
                    focusColor: KapdhColors.focusRingOnDark.withValues(alpha: 0.12),
                    child: content,
                  ),
                ),
              ),
            ),
    );
  }

  Widget _fit(Widget content) => fill
      ? Center(
          child: FittedBox(
            fit: BoxFit.contain,
            child: SizedBox(width: fillContentWidth, child: content),
          ),
        )
      : content;
}

/// Kepala kartu: logo, nama perkumpulan dua baris (putih dan emas) dan label "KTA DIGITAL".
class _CardHeader extends StatelessWidget {
  const _CardHeader();

  static const _tag = Text(
    'KTA DIGITAL',
    style: TextStyle(
      fontSize: KapdhFontSize.overline,
      fontWeight: FontWeight.w600,
      letterSpacing: 1,
      color: KapdhExtraColors.mutedOnDark,
    ),
  );

  @override
  Widget build(BuildContext context) {
    const org = TextStyle(fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.5, height: 1.2);
    final title = Row(
      children: [
        Image.asset('assets/logo-kapdh.png', width: 30, height: 30),
        const SizedBox(width: KapdhSpace.s2),
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
    final large = KtaCard._largeText(MediaQuery.textScalerOf(context));
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
        const PositionedDirectional(top: 2, end: 0, child: _tag),
      ],
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.name, this.image});

  final String name;
  final ImageProvider? image;
  static const double size = 40;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(KapdhRadius.md),
        color: context.kc.tint,
        image: image == null ? null : DecorationImage(image: image!, fit: BoxFit.cover),
      ),
      // Inisial ikut skala teks (mockup: 16px x --ts) tetapi selalu satu baris dan mengecil bila tidak muat di ubin
      // 40 x 40, sehingga tidak pecah atau meluap menimpa nama pada teks 200 %.
      child: image == null
          ? FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                initialsOf(name),
                maxLines: 1,
                softWrap: false,
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, height: 1, color: context.kc.primary),
              ),
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
        padding: const EdgeInsets.all(KapdhSpace.s2),
        decoration: BoxDecoration(color: KapdhColors.surface, borderRadius: BorderRadius.circular(KapdhRadius.md)),
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
      padding: const EdgeInsets.all(KapdhSpace.s2),
      decoration: BoxDecoration(
        color: KapdhExtraColors.qrPlaceholderFill,
        border: Border.all(color: KapdhExtraColors.qrPlaceholderBorder),
        borderRadius: BorderRadius.circular(KapdhRadius.md),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          // Gembok emas 28 px (prototipe layar 6, diringkas untuk kartu landscape): QR terkunci sampai KTA aktif atau
          // tersinkron.
          const ExcludeSemantics(
            child: Icon(KapdhIcons.lockOutline, size: KapdhIconSize.xl, color: KapdhColors.accent),
          ),
          const SizedBox(height: 6),
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
      decoration: BoxDecoration(
        gradient: KapdhGradients.ktaCard,
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
        boxShadow: context.kc.shadowKta,
      ),
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
              Flexible(
                child: Align(alignment: AlignmentDirectional.topEnd, child: StatusBadge(status)),
              ),
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
          style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.45, color: context.kc.textMuted),
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
        color: context.kc.surface,
        border: Border.all(color: context.kc.cardBorder),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
        boxShadow: context.kc.shadowSm,
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
