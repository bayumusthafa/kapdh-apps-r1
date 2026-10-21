import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../core/cache/kta_cache_store.dart';
import '../../core/format/formatters.dart';

/// Cara membuka tujuan aksi kartu: `go` mengganti tumpukan (alur pendaftaran), `push` dapat kembali ke KTA.
enum KtaNavigation { go, push }

/// Aksi pada kartu status di bawah KTA (guideline hal. 6 "Perpanjang", prototipe layar 6 "Bayar").
@immutable
class KtaAction {
  const KtaAction({required this.label, this.location, this.navigation = KtaNavigation.push});

  final String label;

  /// Null = tombol tampil nonaktif (mis. perpanjangan belum dibuka; F-07 "Perpanjang hanya bila layak").
  final String? location;
  final KtaNavigation navigation;

  bool get enabled => location != null;
}

/// Keterangan dan aksi kartu status untuk KTA online. Mengikuti `status_label` dan `action` dari server
/// (MemberCardAction, kontrak C2); klien tidak menghitung kelayakan sendiri (PRD 2.2, AC F07-5).
///
/// Bila "Perpanjang" tampil nonaktif, alasannya selalu tertulis di keterangan tepat sebelum tombol (terbaca pengguna
/// dan pembaca layar): tanggal pembukaan jendela, atau "belum dibuka" bila server belum menetapkannya (N-11,
/// PRD 4.5).
({String message, KtaAction? action}) ktaStatusOf(MemberCard card) {
  final expires = card.expiresAt;
  final opens = card.renewalOpensAt;
  final serverAction = switch (card.action) {
    MemberCardAction.payRegistration => const KtaAction(
      label: 'Bayar',
      location: AppRoutes.onboardingFees,
      navigation: KtaNavigation.go,
    ),
    MemberCardAction.continuePayment when card.openPaymentId != null => KtaAction(
      label: 'Lanjutkan',
      location: AppRoutes.payment(card.openPaymentId!),
    ),
    MemberCardAction.renew => const KtaAction(label: 'Perpanjang', location: AppRoutes.renewal),
    _ => null,
  };
  switch (card.statusLabel) {
    case MemberCardStatus.active:
      final String message;
      if (opens != null) {
        message = 'Keanggotaan organisasi aktif. Perpanjangan dibuka mulai ${formatDate(opens)}.';
      } else if (serverAction == null) {
        // Tombol Perpanjang nonaktif tanpa tanggal pembukaan: alasannya tetap disebutkan.
        message = 'Keanggotaan organisasi aktif. Perpanjangan belum dibuka.';
      } else {
        message = 'Keanggotaan organisasi aktif.';
      }
      return (message: message, action: serverAction ?? const KtaAction(label: 'Perpanjang'));
    case MemberCardStatus.expiring:
      return (
        message: expires == null
            ? 'Masa aktif segera berakhir. Perpanjang agar keanggotaan tidak terputus.'
            : 'Masa aktif berakhir ${formatDate(expires)}. Perpanjang agar keanggotaan tidak terputus.',
        action: serverAction,
      );
    case MemberCardStatus.inactive:
      return (
        message: card.action == MemberCardAction.continuePayment
            ? 'Iuran pendaftaran sedang diproses. Lihat status pembayaran Anda.'
            : 'Selesaikan iuran pendaftaran. KTA berlaku setelah pengurus memverifikasi iuran organisasi Anda.',
        action: serverAction,
      );
    case MemberCardStatus.expired:
      return (
        message: expires == null
            ? 'Masa keanggotaan sudah berakhir. Hubungi pengurus atau perpanjang keanggotaan organisasi.'
            : 'Masa keanggotaan berakhir ${formatDate(expires)}. Hubungi pengurus atau perpanjang keanggotaan '
                  'organisasi.',
        action: serverAction,
      );
    case MemberCardStatus.suspended:
      return (
        message: 'Akun sedang dibatasi pengurus. KTA tidak dapat dipakai sebagai bukti keanggotaan.',
        action: null,
      );
    case MemberCardStatus.unknown:
      return (message: 'Status kartu belum dikenal versi aplikasi ini. Perbarui aplikasi.', action: null);
  }
}

/// Judul dan keterangan saat KTA tidak dapat ditampilkan karena server tidak terjangkau (AC F05-3).
({String title, String message}) ktaOfflineMissOf(KtaCacheMissReason reason) => switch (reason) {
  KtaCacheMissReason.empty || KtaCacheMissReason.otherAccount => (
    title: 'KTA belum tersimpan di perangkat ini',
    message:
        'Sambungkan internet untuk menampilkan KTA. Setelah tersinkron, KTA dapat ditunjukkan offline sampai 7 hari.',
  ),
  KtaCacheMissReason.stale => (
    title: 'Kartu offline perlu disinkronkan',
    message:
        'Sinkronisasi terakhir sudah lebih dari 7 hari atau masa QR sudah habis, sehingga KTA offline tidak '
        'ditampilkan. Sambungkan internet lalu sinkronkan.',
  ),
  KtaCacheMissReason.membershipExpired => (
    title: 'Masa berlaku kartu tersimpan sudah lewat',
    message: 'Sambungkan internet untuk memeriksa status keanggotaan terbaru atau memperpanjang KTA.',
  ),
  KtaCacheMissReason.restricted => (
    title: 'Kartu tidak dapat ditampilkan offline',
    message: 'Status kartu terakhir sedang dibatasi. Sambungkan internet untuk memeriksa status terbaru.',
  ),
  KtaCacheMissReason.clockSkew => (
    title: 'Jam perangkat tidak sesuai',
    message: 'Aktifkan tanggal dan jam otomatis di pengaturan perangkat, lalu sinkronkan KTA kembali.',
  ),
};
