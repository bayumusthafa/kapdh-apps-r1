import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/account/avatar_image.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'account_fixtures.dart';

/// JPEG minimal (magic bytes FF D8 FF) untuk pratinjau dan unggahan uji.
final Uint8List _jpeg = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, ...List<int>.filled(64, 0)]);

void main() {
  Future<AppHarness> openProfile(
    WidgetTester tester, {
    Map<String, Object?>? me,
    FakeHandler? patch,
    Map<String, FakeHandler> extra = const {},
    AvatarPicker? picker,
    double textScale = 1,
  }) async {
    final profile = me ?? meFullJson();
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      overrides: [if (picker != null) avatarPickerProvider.overrideWithValue(picker)],
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, profile),
        '/me/profile': patch ?? (_) => FakeResponse.json(200, meFullJson(version: '4')),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        ...extra,
      }),
    );
    app.router.go('/account');
    await settle(tester);
    app.router.push('/account/profile');
    await settle(tester);
    return app;
  }

  Finder field(String key) =>
      find.descendant(of: find.byKey(ValueKey('profile-$key')), matching: find.byType(EditableText));

  Future<void> enter(WidgetTester tester, String key, String text) async {
    await scrollTo(tester, field(key));
    await tester.enterText(field(key), text);
    await tester.pump();
  }

  Future<void> save(WidgetTester tester) async {
    // Snackbar sebelumnya dapat menutupi tombol di bagian bawah layar.
    tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger).first).clearSnackBars();
    await settle(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-save')));
    await settle(tester);
  }

  List<RequestOptions> patches(AppHarness app) =>
      app.adapter.requests.where((r) => r.path == '/me/profile' && r.method == 'PATCH').toList();

  testWidgets('F-10: formulir terisi dari GET /me; identitas keanggotaan hanya dibaca (AC F05-6)', (tester) async {
    final app = await openProfile(
      tester,
      me: meFullJson(phone: '+62 812 1111 2222', bio: 'Guru matematika.'),
    );
    expect(app.location, '/account/profile');
    expect(find.text('Ubah Profil'), findsOneWidget);
    expect(find.text('Pekanbaru'), findsOneWidget);
    expect(find.text('+62 812 1111 2222'), findsOneWidget);
    expect(find.text('Guru matematika.'), findsOneWidget);
    // Nama, email, nomor anggota dan angkatan tampil sebagai teks, bukan field yang dapat diubah.
    expect(find.text('29.01.01.7'), findsOneWidget);
    expect(find.text('KAPDH 29 · lulus 2025'), findsOneWidget);
    expect(find.textContaining('hanya dapat dikoreksi pengurus'), findsOneWidget);
    // Tanpa perubahan tombol simpan nonaktif.
    await scrollTo(tester, find.byKey(const ValueKey('profile-save')));
    await tester.tap(find.byKey(const ValueKey('profile-save')));
    await settle(tester);
    expect(patches(app), isEmpty);
  });

  testWidgets('AC F15-4: simpan hanya field yang berubah dengan If-Match versi profil', (tester) async {
    final app = await openProfile(tester);
    await enter(tester, 'city', ' Dumai ');
    await enter(tester, 'bio', 'Pengajar bahasa Arab.');
    await enter(tester, 'social_instagram', 'ahmad.islam');
    await save(tester);
    final requests = patches(app);
    expect(requests, hasLength(1));
    expect(headerOf(requests.single, 'If-Match'), '3');
    expect(bodyOf(requests.single), {
      'city': 'Dumai',
      'bio': 'Pengajar bahasa Arab.',
      'social_instagram': 'ahmad.islam',
    });
    expect(find.text('Profil tersimpan.'), findsOneWidget);
    expect(app.location, '/account');
  });

  testWidgets('field nullable yang dikosongkan dikirim null; kota tidak boleh dikosongkan', (tester) async {
    final app = await openProfile(tester, me: meFullJson(phone: '0812345678'));
    await enter(tester, 'phone', '');
    await enter(tester, 'city', '');
    await save(tester);
    expect(patches(app), isEmpty);
    expect(find.text('Kota domisili tidak boleh dikosongkan.'), findsOneWidget);
    await enter(tester, 'city', 'Pekanbaru');
    await save(tester);
    expect(bodyOf(patches(app).single), {'phone': null});
  });

  testWidgets('validasi lokal: telepon dan media sosial mengikuti aturan kontrak (N-09)', (tester) async {
    final app = await openProfile(tester);
    await enter(tester, 'phone', 'nomor saya');
    await enter(tester, 'social_x', 'javascript:alert(1)');
    await save(tester);
    expect(patches(app), isEmpty);
    expect(find.text('Gunakan angka, boleh diawali + (mis. +62 812 3456 7890).'), findsOneWidget);
    expect(find.text('Isi nama pengguna atau tautan yang diawali https://'), findsOneWidget);
  });

  testWidgets('galat server per field ditampilkan pada field terkait', (tester) async {
    await openProfile(
      tester,
      patch: (_) => FakeResponse.json(
        400,
        errorJson(
          'VALIDATION_ERROR',
          'Periksa kembali isian yang ditandai.',
          fieldErrors: {
            'social_linkedin': ['Tautan harus https.'],
          },
        ),
      ),
    );
    await enter(tester, 'social_linkedin', 'https://www.linkedin.com/in/ahmad');
    await save(tester);
    expect(find.text('Tautan harus https.'), findsOneWidget);
  });

  testWidgets('AC F10-4: profesi nonaktif tampil sebagai label historis; pilihan baru hanya dari master aktif', (
    tester,
  ) async {
    final app = await openProfile(
      tester,
      me: meFullJson(profession: masterJson('p-old', 'Penyuluh Lapangan', active: false)),
      extra: {
        '/masters/professions': (_) => FakeResponse.json(200, {
          'items': [masterJson('p-1', 'Guru'), masterJson('p-2', 'Dokter')],
        }),
      },
    );
    expect(find.text('Penyuluh Lapangan (tidak aktif)'), findsOneWidget);
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-profession')));
    await settle(tester);
    expect(find.text('Pilih profesi'), findsWidgets);
    expect(find.text('Guru'), findsOneWidget);
    expect(find.text('Dokter'), findsOneWidget);
    // Master nonaktif tidak dapat dipilih baru dari daftar aktif.
    expect(find.descendant(of: find.byType(BottomSheet), matching: find.text('Penyuluh Lapangan')), findsNothing);
    await tester.tap(find.text('Guru'));
    await settle(tester);
    expect(find.text('Guru'), findsOneWidget);
    await save(tester);
    expect(bodyOf(patches(app).single), {'profession_id': 'p-1'});
  });

  testWidgets('AC F10-4: keahlian maksimal 10 dari master aktif; keahlian nonaktif dapat dilepas', (tester) async {
    final app = await openProfile(
      tester,
      me: meFullJson(skills: [masterJson('s-old', 'Mengetik Cepat', active: false)]),
      extra: {
        '/masters/skills': (_) => FakeResponse.json(200, {
          'items': [for (var i = 1; i <= 11; i++) masterJson('s-$i', 'Keahlian $i')],
        }),
      },
    );
    expect(find.text('Mengetik Cepat (tidak aktif)'), findsOneWidget);
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-skills')));
    await settle(tester);
    // Lepas keahlian historis, lalu pilih sampai batas.
    await tester.tap(find.text('Mengetik Cepat'));
    await tester.pump();
    for (var i = 1; i <= 10; i++) {
      await tester.ensureVisible(find.text('Keahlian $i'));
      await tester.tap(find.text('Keahlian $i'));
      await tester.pump();
    }
    expect(find.textContaining('Maksimal 10 keahlian'), findsOneWidget);
    await tester.ensureVisible(find.text('Keahlian 11'));
    final eleventh = tester.widget<CheckboxListTile>(find.byKey(const ValueKey('master-s-11')));
    expect(eleventh.onChanged, isNull);
    await tester.tap(find.byKey(const ValueKey('master-done')));
    await settle(tester);
    expect(find.text('10 dari 10 dipilih'), findsOneWidget);
    await save(tester);
    expect(bodyOf(patches(app).single), {
      'skill_ids': [for (var i = 1; i <= 10; i++) 's-$i'],
    });
  });

  testWidgets('AC F15-4 PRD 4.5: konflik versi menampilkan versi terbaru dan tombol muat ulang', (tester) async {
    var calls = 0;
    final app = await openProfile(
      tester,
      patch: (options) {
        calls++;
        if (calls == 1) {
          return FakeResponse.json(
            409,
            errorJson(
              'VERSION_CONFLICT',
              'Data sudah diubah orang lain.',
              current: meFullJson(version: '4', city: 'Bangkinang'),
            ),
          );
        }
        return FakeResponse.json(200, meFullJson(version: '5', city: 'Dumai'));
      },
    );
    await enter(tester, 'city', 'Dumai');
    await save(tester);
    expect(find.text('Profil diubah di perangkat lain'), findsOneWidget);
    await tester.tap(find.text('Muat terbaru'));
    await settle(tester);
    expect(find.text('Bangkinang'), findsOneWidget);

    // Terapkan isian sendiri di atas versi terbaru: If-Match memakai versi server terbaru.
    await enter(tester, 'city', 'Dumai');
    await save(tester);
    final requests = patches(app);
    expect(requests, hasLength(2));
    expect(headerOf(requests.last, 'If-Match'), '4');
    expect(bodyOf(requests.last), {'city': 'Dumai'});
  });

  testWidgets('AC F15-4 PRD 4.5: "Pakai isian saya" hanya menerapkan field yang diubah; perubahan perangkat lain '
      'tidak tertimpa', (tester) async {
    var calls = 0;
    final app = await openProfile(
      tester,
      extra: {
        '/masters/professions': (_) => FakeResponse.json(200, {
          'items': [masterJson('p-1', 'Guru'), masterJson('p-2', 'Dokter')],
        }),
      },
      patch: (options) {
        calls++;
        if (calls == 1) {
          // Perangkat lain mengubah kota, Instagram dan keahlian.
          return FakeResponse.json(
            409,
            errorJson(
              'VERSION_CONFLICT',
              'Data sudah diubah orang lain.',
              current: meFullJson(
                version: '4',
                city: 'Bangkinang',
                instagram: 'ahmad.baru',
                skills: [masterJson('s-9', 'Public speaking')],
              ),
            ),
          );
        }
        return FakeResponse.json(200, meFullJson(version: '5', city: 'Bangkinang', bio: 'Bio baru saya'));
      },
    );
    // Pengguna hanya mengubah bio dan profesi.
    await enter(tester, 'bio', 'Bio baru saya');
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-profession')));
    await settle(tester);
    await tester.tap(find.text('Guru'));
    await settle(tester);
    await save(tester);
    expect(find.text('Profil diubah di perangkat lain'), findsOneWidget);
    await tester.tap(find.text('Pakai isian saya'));
    await settle(tester);

    // Formulir kini berbasis versi terbaru: kota, Instagram dan keahlian dari perangkat lain; bio dan profesi tetap
    // isian sendiri.
    expect(find.text('Bangkinang'), findsOneWidget);
    expect(find.text('ahmad.baru'), findsOneWidget);
    expect(find.text('Public speaking'), findsOneWidget);
    expect(find.text('Bio baru saya'), findsOneWidget);
    expect(find.text('Guru'), findsOneWidget);

    await save(tester);
    final requests = patches(app);
    expect(requests, hasLength(2));
    expect(headerOf(requests.last, 'If-Match'), '4');
    expect(bodyOf(requests.last), {'bio': 'Bio baru saya', 'profession_id': 'p-1'});
  });

  testWidgets('PRD 4.5: konflik tanpa versi terbaru dan GET /me gagal menampilkan galat dengan coba lagi; isian utuh', (
    tester,
  ) async {
    var conflicted = false;
    var failLatest = true;
    var patchCalls = 0;
    final app = await openProfile(
      tester,
      extra: {
        '/me': (_) {
          if (!conflicted) return FakeResponse.json(200, meFullJson());
          if (failLatest) {
            failLatest = false;
            return FakeResponse.network();
          }
          return FakeResponse.json(200, meFullJson(version: '4', bio: 'Bio dari perangkat lain'));
        },
      },
      patch: (_) {
        patchCalls++;
        if (patchCalls == 1) {
          conflicted = true;
          // 409 tanpa `current`: klien memuat versi terbaru sendiri.
          return FakeResponse.json(409, errorJson('VERSION_CONFLICT', 'Data sudah diubah orang lain.'));
        }
        return FakeResponse.json(200, meFullJson(version: '5', city: 'Dumai'));
      },
    );
    await enter(tester, 'city', 'Dumai');
    await save(tester);
    // Galat memuat versi terbaru tidak lolos sebagai galat tak tertangani; isian tetap dan "Coba lagi" tersedia.
    expect(tester.takeException(), isNull);
    expect(find.text('Profil diubah di perangkat lain'), findsNothing);
    expect(find.text('Dumai'), findsOneWidget);
    expect(find.widgetWithText(SnackBarAction, 'Coba lagi'), findsOneWidget);
    expect(app.location, '/account/profile');

    await tester.tap(find.widgetWithText(SnackBarAction, 'Coba lagi'));
    await settle(tester);
    expect(find.text('Profil diubah di perangkat lain'), findsOneWidget);
    await tester.tap(find.text('Pakai isian saya'));
    await settle(tester);
    expect(find.text('Bio dari perangkat lain'), findsOneWidget);
    await save(tester);
    final requests = patches(app);
    expect(requests, hasLength(2));
    expect(headerOf(requests.last, 'If-Match'), '4');
    expect(bodyOf(requests.last), {'city': 'Dumai'});
  });

  testWidgets('PRD 4.5: panah kembali app bar pada formulir yang berubah menanyakan "Buang perubahan?"', (
    tester,
  ) async {
    final app = await openProfile(tester);
    await enter(tester, 'city', 'Dumai');
    await tester.tap(find.byTooltip('Kembali'));
    await settle(tester);
    expect(find.text('Buang perubahan?'), findsOneWidget);
    expect(app.location, '/account/profile');

    await tester.tap(find.text('Lanjut mengubah'));
    await settle(tester);
    expect(app.location, '/account/profile');
    expect(find.text('Dumai'), findsOneWidget);

    await tester.tap(find.byTooltip('Kembali'));
    await settle(tester);
    await tester.tap(find.text('Buang'));
    await settle(tester);
    expect(app.location, '/account');
    expect(patches(app), isEmpty);

    // Formulir tanpa perubahan langsung kembali tanpa dialog.
    app.router.push('/account/profile');
    await settle(tester);
    await tester.tap(find.byTooltip('Kembali'));
    await settle(tester);
    expect(find.text('Buang perubahan?'), findsNothing);
    expect(app.location, '/account');
  });

  testWidgets('N-10: foto profil diunggah sebagai purpose avatar lalu dilampirkan lewat avatar_file_id', (
    tester,
  ) async {
    final app = await openProfile(
      tester,
      picker: (source) async => PickedAvatar(bytes: _jpeg, name: 'IMG_0001.jpg'),
      extra: {'/files': (_) => FakeResponse.json(201, fileRefJson('file-avatar-1'))},
    );
    await scrollAndTap(tester, find.byKey(const ValueKey('avatar-change')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('avatar-source-gallery')));
    await settle(tester);
    expect(find.byKey(const ValueKey('avatar-delete')), findsOneWidget);
    await save(tester);
    final uploads = app.adapter.requests.where((r) => r.path == '/files' && r.method == 'POST').toList();
    expect(uploads, hasLength(1));
    final form = uploads.single.data as FormData;
    expect(form.fields.any((f) => f.key == 'purpose' && f.value == 'avatar'), isTrue);
    expect(form.files.single.value.filename, 'avatar.jpg');
    expect(bodyOf(patches(app).single), {'avatar_file_id': 'file-avatar-1'});
  });

  testWidgets('N-10: foto bukan JPG/PNG/WebP ditolak sebelum diunggah', (tester) async {
    final gif = Uint8List.fromList([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]);
    final app = await openProfile(
      tester,
      picker: (source) async => PickedAvatar(bytes: gif, name: 'anim.gif'),
    );
    await scrollAndTap(tester, find.byKey(const ValueKey('avatar-change')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('avatar-source-gallery')));
    await settle(tester);
    expect(find.text('Foto tidak dapat dipakai'), findsOneWidget);
    expect(find.textContaining('Gunakan foto JPG, PNG atau WebP'), findsWidgets);
    await tester.tap(find.text('Tutup'));
    await settle(tester);
    expect(app.adapter.requests.where((r) => r.path == '/files'), isEmpty);
  });

  test('N-10: aturan foto profil lokal (magic bytes dan 5 MB)', () {
    expect(avatarProblem(PickedAvatar(bytes: _jpeg, name: 'a.jpg')), isNull);
    final png = Uint8List.fromList([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]);
    expect(imageMimeOf(png), 'image/png');
    final webp = Uint8List.fromList([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(imageMimeOf(webp), 'image/webp');
    final big = Uint8List(avatarMaxBytes + 1)..setAll(0, [0xFF, 0xD8, 0xFF]);
    expect(avatarProblem(PickedAvatar(bytes: big, name: 'besar.jpg')), 'Ukuran foto melebihi 5 MB.');
    // Ekstensi tidak menentukan jenis: isi PDF bernama .jpg ditolak.
    final pdf = Uint8List.fromList('%PDF-1.7'.codeUnits);
    expect(avatarProblem(PickedAvatar(bytes: pdf, name: 'foto.jpg')), 'Gunakan foto JPG, PNG atau WebP.');
  });

  testWidgets('hapus foto mengirim avatar_file_id null', (tester) async {
    final app = await openProfile(tester, me: meFullJson(avatarFileId: 'file-lama'));
    await scrollAndTap(tester, find.byKey(const ValueKey('avatar-delete')));
    await settle(tester);
    await save(tester);
    expect(bodyOf(patches(app).single), {'avatar_file_id': null});
  });

  testWidgets('PRD 4.5: profil gagal dimuat menampilkan galat dengan coba lagi', (tester) async {
    var calls = 0;
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) {
          calls++;
          // Panggilan pertama untuk bootstrap sesi, kedua untuk layar profil.
          return calls == 2 ? FakeResponse.network() : FakeResponse.json(200, meFullJson());
        },
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
      }),
    );
    app.router.push('/account/profile');
    await settle(tester);
    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(find.text('Pekanbaru'), findsOneWidget);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openProfile(tester, textScale: 2);
    expect(tester.takeException(), isNull);
    await scrollTo(tester, find.byKey(const ValueKey('profile-save')));
    expect(tester.takeException(), isNull);
  });
}
