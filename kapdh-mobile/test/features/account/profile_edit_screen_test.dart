import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';
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

  /// Widget berkunci `<prefix><id draf>` ke-[index] (baris daftar berulang berkunci id stabil).
  Finder keyed(String prefix, int index) => find
      .byWidgetPredicate((w) => w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith(prefix))
      .at(index);

  Finder educationField(int index, String name) =>
      find.descendant(of: keyed('profile-education-$name-', index), matching: find.byType(EditableText));

  Finder educationDropdown(int index, String name) => keyed('profile-education-$name-', index);

  Finder linkPlatform(int index) => keyed('profile-link-platform-', index);

  Finder linkValue(int index) =>
      find.descendant(of: keyed('profile-link-value-', index), matching: find.byType(EditableText));

  Future<void> addLink(WidgetTester tester) async {
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-link-add')));
    await settle(tester);
  }

  /// Memilih [label] dari dropdown; menu terbuka di lapisan atas sehingga item menu adalah kemunculan terakhir.
  Future<void> chooseDropdown(WidgetTester tester, Finder dropdown, String label) async {
    await scrollAndTap(tester, dropdown);
    await settle(tester);
    await tester.tap(find.text(label).last);
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
    await save(tester);
    final requests = patches(app);
    expect(requests, hasLength(1));
    expect(headerOf(requests.single, 'If-Match'), '3');
    // Field lama aplikasi 1.0.0 tidak pernah dikirim; daftar yang tidak diubah juga tidak.
    expect(bodyOf(requests.single), {'city': 'Dumai', 'bio': 'Pengajar bahasa Arab.'});
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
    await addLink(tester);
    await tester.enterText(linkValue(0), 'javascript:alert(1)');
    await save(tester);
    expect(patches(app), isEmpty);
    expect(find.text('Gunakan angka, boleh diawali + (mis. +62 812 3456 7890).'), findsOneWidget);
    expect(find.text('Isi nama pengguna atau tautan yang diawali https://'), findsOneWidget);
  });

  testWidgets('galat server bersarang (social_links.0.value) ditampilkan pada baris terkait', (tester) async {
    await openProfile(
      tester,
      patch: (_) => FakeResponse.json(
        400,
        errorJson(
          'VALIDATION_ERROR',
          'Periksa kembali isian yang ditandai.',
          fieldErrors: {
            'social_links.0.value': ['Tautan harus https.'],
          },
        ),
      ),
    );
    await addLink(tester);
    await tester.enterText(linkValue(0), 'https://www.linkedin.com/in/ahmad.uji');
    await save(tester);
    expect(find.text('Tautan harus https.'), findsOneWidget);
  });

  testWidgets('v2: profesi lebih dari satu dari daftar master atau ketik sendiri; label historis dapat dilepas', (
    tester,
  ) async {
    final app = await openProfile(
      tester,
      me: meFullJson(professions: ['Penyuluh Lapangan']),
      extra: {
        '/masters/professions': (_) => FakeResponse.json(200, {
          'items': [masterJson('p-1', 'Guru'), masterJson('p-2', 'Dokter')],
        }),
      },
    );
    expect(find.text('Penyuluh Lapangan'), findsOneWidget);
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-professions-picker')));
    await settle(tester);
    final sheet = find.byType(BottomSheet);
    expect(find.descendant(of: sheet, matching: find.text('Pilih profesi')), findsOneWidget);
    // Profesi terpasang di luar daftar master tampil tercentang; master aktif dapat dipilih lebih dari satu.
    expect(find.descendant(of: sheet, matching: find.text('Penyuluh Lapangan')), findsOneWidget);
    await tester.tap(find.descendant(of: sheet, matching: find.text('Guru')));
    await tester.pump();
    // Ketik sendiri: "Tambah …" hanya bila tidak sama dengan master atau pilihan yang ada.
    await tester.enterText(find.byKey(const ValueKey('master-search')), 'guru');
    await tester.pump();
    expect(find.byKey(const ValueKey('profession-add-typed')), findsNothing);
    await tester.enterText(find.byKey(const ValueKey('master-search')), '  Penulis Lepas ');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('profession-add-typed')));
    await tester.pump();
    expect(find.textContaining('Dipilih 3 dari maksimal 5'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('master-done')));
    await settle(tester);
    expect(find.bySemanticsLabel('Hapus profesi Penulis Lepas'), findsOneWidget);
    // Cip seluruhnya menghapus: lepas profesi pertama.
    await scrollAndTap(tester, find.bySemanticsLabel('Hapus profesi Penyuluh Lapangan'));
    await save(tester);
    expect(bodyOf(patches(app).single), {
      'professions': ['Guru', 'Penulis Lepas'],
    });
  });

  testWidgets('v2: maksimal 5 profesi; pilihan ke-6 dinonaktifkan', (tester) async {
    await openProfile(
      tester,
      me: meFullJson(professions: ['A', 'B', 'C', 'D', 'E']),
      extra: {
        '/masters/professions': (_) => FakeResponse.json(200, {
          'items': [masterJson('p-1', 'Guru')],
        }),
      },
    );
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-professions-picker')));
    await settle(tester);
    expect(find.textContaining('Maksimal 5 profesi'), findsOneWidget);
    expect(tester.widget<CheckboxListTile>(find.byKey(const ValueKey('master-p-1'))).onChanged, isNull);
    await tester.enterText(find.byKey(const ValueKey('master-search')), 'Penulis');
    await tester.pump();
    expect(tester.widget<ListTile>(find.byKey(const ValueKey('profession-add-typed'))).enabled, isFalse);
  });

  testWidgets('v2: riwayat pendidikan berulang: tambah, isi strata dan tahun, hapus; baris kosong diabaikan', (
    tester,
  ) async {
    final app = await openProfile(
      tester,
      me: meFullJson(
        education: [educationEntryJson('Universitas Riau', major: 'Pendidikan Bahasa Arab', level: 's1', year: 2019)],
      ),
    );
    expect(find.text('Pendidikan 1'), findsOneWidget);
    expect(find.text('Universitas Riau'), findsOneWidget);
    expect(find.text('S1'), findsOneWidget);
    expect(find.text('2019'), findsOneWidget);
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-education-add')));
    await settle(tester);
    expect(find.text('Pendidikan 2'), findsOneWidget);
    // Baris baru masih kosong: belum ada perubahan untuk disimpan.
    await scrollTo(tester, find.byKey(const ValueKey('profile-save')));
    expect(tester.widget<KapdhButton>(find.byKey(const ValueKey('profile-save'))).onPressed, isNull);

    await scrollTo(tester, educationField(1, 'institution'));
    await tester.enterText(educationField(1, 'institution'), 'UIN Sultan Syarif Kasim Riau');
    await tester.enterText(educationField(1, 'major'), 'Pendidikan Agama Islam');
    await chooseDropdown(tester, educationDropdown(1, 'level'), 'S2');
    await chooseDropdown(tester, educationDropdown(1, 'year'), '2022');
    // Tambah baris ketiga lalu hapus lagi (tombol hapus merah per baris).
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-education-add')));
    await settle(tester);
    await scrollAndTap(tester, find.byTooltip('Hapus Pendidikan 3'));
    await settle(tester);
    expect(find.text('Pendidikan 3'), findsNothing);
    await save(tester);
    expect(bodyOf(patches(app).single), {
      'education': [
        {'institution': 'Universitas Riau', 'major': 'Pendidikan Bahasa Arab', 'level': 's1', 'graduation_year': 2019},
        {
          'institution': 'UIN Sultan Syarif Kasim Riau',
          'major': 'Pendidikan Agama Islam',
          'level': 's2',
          'graduation_year': 2022,
        },
      ],
    });
  });

  testWidgets('v2: riwayat tanpa universitas/instansi ditandai; hapus semua riwayat mengirim []', (tester) async {
    final app = await openProfile(tester, me: meFullJson(education: [educationEntryJson('Universitas Riau')]));
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-education-add')));
    await settle(tester);
    await scrollTo(tester, educationField(1, 'major'));
    await tester.enterText(educationField(1, 'major'), 'Manajemen');
    await save(tester);
    expect(patches(app), isEmpty);
    expect(find.text('Isi universitas/instansi atau hapus riwayat ini.'), findsOneWidget);
    await scrollAndTap(tester, find.byTooltip('Hapus Pendidikan 2'));
    await settle(tester);
    await scrollAndTap(tester, find.byTooltip('Hapus Pendidikan 1'));
    await settle(tester);
    await save(tester);
    expect(bodyOf(patches(app).single), {'education': <Object?>[]});
  });

  testWidgets('v2: media sosial dinamis: menu platform berlogo, nilai dinormalkan, maksimal 10 tautan', (tester) async {
    final app = await openProfile(
      tester,
      me: meFullJson(
        socialLinks: [
          {'platform': 'instagram', 'value': 'fauzi.uji'},
        ],
      ),
    );
    expect(find.text('fauzi.uji'), findsOneWidget);
    await addLink(tester);
    // Tautan baru memakai platform pertama yang belum dipakai (TikTok); menu platform berisi sembilan pilihan.
    expect(find.byTooltip('Hapus tautan TikTok'), findsOneWidget);
    await scrollAndTap(tester, linkPlatform(1));
    await settle(tester);
    for (final label in [
      'Instagram',
      'TikTok',
      'X (Twitter)',
      'Facebook',
      'LinkedIn',
      'YouTube',
      'Threads',
      'Telegram',
      'Situs web',
    ]) {
      expect(find.text(label), findsWidgets, reason: label);
    }
    await tester.tap(find.text('Situs web').last);
    await settle(tester);
    await tester.enterText(linkValue(1), 'kapdh');
    await save(tester);
    expect(patches(app), isEmpty);
    expect(find.text('Isi tautan yang diawali https://'), findsOneWidget);
    await tester.enterText(linkValue(1), 'https://contoh.test/fauzi');
    await tester.pump();
    for (var i = 2; i < 10; i++) {
      await addLink(tester);
      await tester.enterText(linkValue(i), 'https://contoh.test/akun$i');
    }
    expect(find.byKey(const ValueKey('profile-link-add')), findsNothing);
    await save(tester);
    final links = bodyOf(patches(app).single)['social_links']! as List<Object?>;
    expect(links, hasLength(10));
    expect(links.take(2), [
      {'platform': 'instagram', 'value': 'fauzi.uji'},
      {'platform': 'website', 'value': 'https://contoh.test/fauzi'},
    ]);
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
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-skills-picker')));
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
          // Perangkat lain mengubah kota, tautan Instagram, riwayat pendidikan dan keahlian.
          return FakeResponse.json(
            409,
            errorJson(
              'VERSION_CONFLICT',
              'Data sudah diubah orang lain.',
              current: meFullJson(
                version: '4',
                city: 'Bangkinang',
                instagram: 'ahmad.uji.baru',
                education: [educationEntryJson('Universitas Perangkat Lain')],
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
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-professions-picker')));
    await settle(tester);
    await tester.tap(find.text('Guru'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('master-done')));
    await settle(tester);
    await save(tester);
    expect(find.text('Profil diubah di perangkat lain'), findsOneWidget);
    await tester.tap(find.text('Pakai isian saya'));
    await settle(tester);

    // Formulir kini berbasis versi terbaru: kota, tautan, pendidikan dan keahlian dari perangkat lain; bio dan profesi
    // tetap isian sendiri.
    expect(find.text('Bangkinang'), findsOneWidget);
    expect(find.text('ahmad.uji.baru'), findsOneWidget);
    expect(find.text('Universitas Perangkat Lain'), findsOneWidget);
    expect(find.text('Public speaking'), findsOneWidget);
    expect(find.text('Bio baru saya'), findsOneWidget);
    expect(find.text('Guru'), findsOneWidget);

    await save(tester);
    final requests = patches(app);
    expect(requests, hasLength(2));
    expect(headerOf(requests.last, 'If-Match'), '4');
    expect(bodyOf(requests.last), {
      'bio': 'Bio baru saya',
      'professions': ['Guru'],
    });
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

  testWidgets('N-13: tautan berplatform baru (belum dikenal) mengunci Media Sosial; simpan tidak menghapusnya', (
    tester,
  ) async {
    final app = await openProfile(
      tester,
      me: meFullJson(
        socialLinks: [
          {'platform': 'instagram', 'value': 'fauzi.uji'},
          {'platform': 'whatsapp', 'value': 'https://wa.me/6281200000001'},
        ],
      ),
    );
    await scrollTo(tester, find.textContaining('versi aplikasi yang lebih baru'));
    expect(find.textContaining('versi aplikasi yang lebih baru'), findsOneWidget);
    expect(find.byKey(const ValueKey('profile-link-add')), findsNothing);
    // Formulir tidak dianggap berubah saat dibuka; perubahan lain tidak mengirim social_links.
    await scrollTo(tester, find.byKey(const ValueKey('profile-save')));
    expect(tester.widget<KapdhButton>(find.byKey(const ValueKey('profile-save'))).onPressed, isNull);
    await enter(tester, 'bio', 'Bio baru');
    await save(tester);
    expect(bodyOf(patches(app).single), {'bio': 'Bio baru'});
  });

  testWidgets('galat server per profesi (professions.N) tampil pada field Profesi', (tester) async {
    await openProfile(
      tester,
      me: meFullJson(professions: ['Guru']),
      extra: {
        '/masters/professions': (_) => FakeResponse.json(200, {
          'items': [masterJson('p-1', 'Guru'), masterJson('p-2', 'Dokter')],
        }),
      },
      patch: (_) => FakeResponse.json(
        400,
        errorJson(
          'VALIDATION_ERROR',
          'Periksa kembali isian yang ditandai.',
          fieldErrors: {
            'professions.1': ['Profesi tidak boleh memuat karakter kontrol'],
          },
        ),
      ),
    );
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-professions-picker')));
    await settle(tester);
    await tester.tap(find.text('Dokter'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('master-done')));
    await settle(tester);
    await save(tester);
    expect(find.text('Profesi tidak boleh memuat karakter kontrol'), findsOneWidget);
  });

  testWidgets('galat server baris tetap pada baris yang dikirim walau baris kosong di atasnya kemudian diisi', (
    tester,
  ) async {
    await openProfile(
      tester,
      patch: (_) => FakeResponse.json(
        400,
        errorJson(
          'VALIDATION_ERROR',
          'Periksa kembali isian yang ditandai.',
          fieldErrors: {
            'education.0.institution': ['Nama institusi ditolak server.'],
          },
        ),
      ),
    );
    // Pendidikan 1 dibiarkan kosong (tidak ikut terkirim), Pendidikan 2 diisi lalu disimpan.
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-education-add')));
    await settle(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('profile-education-add')));
    await settle(tester);
    await scrollTo(tester, educationField(1, 'institution'));
    await tester.enterText(educationField(1, 'institution'), 'Universitas Uji');
    await save(tester);
    Finder errorIn(int row) => find.descendant(
      of: keyed('profile-education-institution-', row),
      matching: find.text('Nama institusi ditolak server.'),
    );
    expect(errorIn(1), findsOneWidget);
    // Baris kosong di atasnya diisi: galat tetap di Pendidikan 2, tidak pindah ke Pendidikan 1.
    await scrollTo(tester, educationField(0, 'institution'));
    await tester.enterText(educationField(0, 'institution'), 'Universitas Lain');
    await tester.pump();
    expect(errorIn(0), findsNothing);
    expect(errorIn(1), findsOneWidget);
  });

  Map<String, Object?> fullLists() => meFullJson(
    professions: ['Guru', 'Penerjemah Lepas', 'Penulis Buku Anak'],
    education: [
      educationEntryJson('UIN Sultan Syarif Kasim Riau', major: 'Pendidikan Agama Islam', level: 's2', year: 2022),
      educationEntryJson('Universitas Riau', major: 'Pendidikan Bahasa Arab', level: 's1', year: 2019),
    ],
    socialLinks: [
      {'platform': 'instagram', 'value': 'fauzi.uji'},
      {'platform': 'linkedin', 'value': 'https://www.linkedin.com/in/fauzi.uji'},
    ],
  );

  testWidgets('N-11: teks 200 % tanpa meluap, termasuk daftar berulang', (tester) async {
    await openProfile(tester, textScale: 2, me: fullLists());
    expect(tester.takeException(), isNull);
    await scrollTo(tester, find.byKey(const ValueKey('profile-link-add')));
    expect(tester.takeException(), isNull);
    await scrollTo(tester, find.byKey(const ValueKey('profile-save')));
    expect(tester.takeException(), isNull);
  });

  testWidgets('tema gelap: kartu daftar berulang memakai palet gelap tanpa galat tata letak', (tester) async {
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    await openProfile(tester, me: fullLists());
    await scrollTo(tester, find.text('Riwayat Pendidikan'));
    expect(Theme.of(tester.element(find.text('Riwayat Pendidikan'))).brightness, Brightness.dark);
    await scrollTo(tester, find.byKey(const ValueKey('profile-link-add')));
    expect(tester.takeException(), isNull);
  });
}
