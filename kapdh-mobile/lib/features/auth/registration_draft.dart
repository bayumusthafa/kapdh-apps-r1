import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

/// Isian pendaftaran non-rahasia yang dipertahankan selama alur daftar → OTP (PRD 4.5: form penting menyimpan input
/// nonrahasia saat gagal jaringan; "Salah email? Ubah alamat email" kembali ke form tanpa mengetik ulang). Sandi tidak
/// pernah disimpan. Hanya di memori; hilang saat aplikasi ditutup.
@immutable
class RegistrationDraft {
  const RegistrationDraft({
    this.fullName = '',
    this.gender,
    this.email = '',
    this.cohort,
    this.classIn,
    this.classOut,
    this.submitted = false,
  });

  final String fullName;
  final Gender? gender;
  final String email;
  final int? cohort;
  final int? classIn;
  final int? classOut;

  /// Challenge OTP sudah dibuat dari draf ini (untuk tautan ubah email di layar OTP).
  final bool submitted;

  RegistrationDraft copyWith({
    String? fullName,
    Gender? gender,
    String? email,
    int? cohort,
    int? classIn,
    int? classOut,
    bool? submitted,
  }) => RegistrationDraft(
    fullName: fullName ?? this.fullName,
    gender: gender ?? this.gender,
    email: email ?? this.email,
    cohort: cohort ?? this.cohort,
    classIn: classIn ?? this.classIn,
    classOut: classOut ?? this.classOut,
    submitted: submitted ?? this.submitted,
  );
}

final registrationDraftProvider = NotifierProvider<RegistrationDraftController, RegistrationDraft?>(
  RegistrationDraftController.new,
);

class RegistrationDraftController extends Notifier<RegistrationDraft?> {
  @override
  RegistrationDraft? build() => null;

  void save(RegistrationDraft draft) => state = draft;

  void markSubmitted() {
    final draft = state;
    if (draft != null) state = draft.copyWith(submitted: true);
  }

  /// Pendaftaran selesai (OTP terverifikasi) atau dibatalkan.
  void clear() => state = null;
}
