// App Links Android, Universal Links dan push iOS (ARCHITECTURE §4.7, AC F13-3, D10). Uji ini menjaga konfigurasi
// platform tetap sama dengan DeepLinks: aplikasi hanya merebut https://kapdh.or.id/app dan /app/<rute>, entitlement iOS
// ada di repo tanpa nilai contoh (Team ID dipilih di Xcode), dan hanya target Runner yang memakainya.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/deep_link/deep_links.dart';

String _read(String path) => File(path).readAsStringSync();

String _withoutComments(String xml) => xml.replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');

/// Blok XCBuildConfiguration per `<id> <nama>` beserta isinya.
Map<String, String> _buildConfigurations(String pbxproj) {
  final start = pbxproj.indexOf('/* Begin XCBuildConfiguration section */');
  final end = pbxproj.indexOf('/* End XCBuildConfiguration section */');
  final section = pbxproj.substring(start, end);
  final headers = RegExp(r'^\s*([0-9A-F]{24}) /\* (\w+) \*/ = \{\r?$', multiLine: true).allMatches(section).toList();
  return {
    for (var i = 0; i < headers.length; i++)
      '${headers[i].group(1)} ${headers[i].group(2)}': section.substring(
        headers[i].end,
        i + 1 < headers.length ? headers[i + 1].start : section.length,
      ),
  };
}

void main() {
  group('Android App Links', () {
    final manifest = _withoutComments(_read('android/app/src/main/AndroidManifest.xml'));
    final filters = RegExp(
      r'<intent-filter\b([^>]*)>(.*?)</intent-filter>',
      dotAll: true,
    ).allMatches(manifest).toList();
    List<String> values(String body, String attribute) =>
        RegExp('android:$attribute\\s*=\\s*"([^"]*)"').allMatches(body).map((match) => match.group(1)!).toList();

    test('tepat satu intent-filter autoVerify: https kapdh.or.id, path "/app" dan awalan "/app/"', () {
      final verified = filters.where((filter) => values(filter.group(1)!, 'autoVerify').contains('true')).toList();
      expect(verified, hasLength(1));
      final body = verified.single.group(2)!;
      expect(values(body, 'scheme'), ['https']);
      expect(values(body, 'host'), ['kapdh.or.id']);
      expect(values(body, 'path'), [DeepLinks.webPrefix]);
      expect(values(body, 'pathPrefix'), ['${DeepLinks.webPrefix}/']);
      expect(values(body, 'pathPattern'), isEmpty);
      expect(values(body, 'pathAdvancedPattern'), isEmpty);
      expect(values(body, 'pathSuffix'), isEmpty);
      expect(DeepLinks.webHosts, contains('kapdh.or.id'));
    });

    test('tidak ada awalan "/app" (merebut /apply, /apps) dan tidak ada path di luar /app, mis. /kta', () {
      final paths = filters.expand(
        (filter) => [
          for (final attribute in ['path', 'pathPrefix', 'pathPattern']) ...values(filter.group(2)!, attribute),
        ],
      );
      expect(paths.toSet(), {'/app', '/app/'});
      expect(manifest, isNot(contains('android:pathPrefix="/app"')));
      expect(manifest, isNot(contains('/kta')));
    });

    test('tautan diteruskan ke go_router (flutter_deeplinking_enabled)', () {
      expect(RegExp(r'android:name="flutter_deeplinking_enabled"\s*android:value="true"').hasMatch(manifest), isTrue);
    });
  });

  group('iOS: entitlement push dan Universal Links', () {
    final raw = _read('ios/Runner/Runner.entitlements');
    final entitlements = _withoutComments(raw);
    String? stringFor(String key) =>
        RegExp('<key>${RegExp.escape(key)}</key>\\s*<string>([^<]*)</string>').firstMatch(entitlements)?.group(1);
    List<String>? arrayFor(String key) {
      final array = RegExp(
        '<key>${RegExp.escape(key)}</key>\\s*<array>(.*?)</array>',
        dotAll: true,
      ).firstMatch(entitlements);
      if (array == null) return null;
      return RegExp(r'<string>([^<]*)</string>').allMatches(array.group(1)!).map((match) => match.group(1)!).toList();
    }

    test('aps-environment development (bawaan Xcode; ekspor distribusi menjadikannya production)', () {
      expect(stringFor('aps-environment'), 'development');
    });

    test('Associated Domains hanya applinks:kapdh.or.id (tanpa www, staging atau mode developer)', () {
      final domains = arrayFor('com.apple.developer.associated-domains');
      expect(domains, ['applinks:kapdh.or.id']);
      for (final domain in domains!) {
        expect(domain, isNot(contains('www.')));
      }
    });

    test('tanpa nilai contoh: Team ID dipilih di Xcode, tidak ditulis di entitlement', () {
      for (final placeholder in ['TEAMID', 'TEAM_ID', 'XXXX', 'placeholder']) {
        expect(raw.toLowerCase(), isNot(contains(placeholder.toLowerCase())), reason: placeholder);
      }
    });

    test('tautan diteruskan ke go_router (FlutterDeepLinkingEnabled)', () {
      expect(
        RegExp(r'<key>FlutterDeepLinkingEnabled</key>\s*<true/>').hasMatch(_read('ios/Runner/Info.plist')),
        isTrue,
      );
    });
  });

  group('iOS: project.pbxproj', () {
    final pbxproj = _read('ios/Runner.xcodeproj/project.pbxproj');
    final configurations = _buildConfigurations(pbxproj);
    final runnerBundle = RegExp(r'PRODUCT_BUNDLE_IDENTIFIER = "?id\.or\.kapdh\.app"?;');

    test('CODE_SIGN_ENTITLEMENTS tepat di blok konfigurasi target Runner (id.or.kapdh.app), tidak di blok lain', () {
      final runner = {
        for (final MapEntry(:key, :value) in configurations.entries)
          if (runnerBundle.hasMatch(value)) key,
      };
      expect(runner, hasLength(3), reason: 'Debug, Release dan Profile target Runner');
      for (final MapEntry(:key, :value) in configurations.entries) {
        final entitlements = RegExp(
          r'CODE_SIGN_ENTITLEMENTS = "?([^";]*)"?;',
        ).allMatches(value).map((match) => match.group(1)).toList();
        expect(entitlements, runner.contains(key) ? ['Runner/Runner.entitlements'] : isEmpty, reason: key);
      }
      expect(RegExp('CODE_SIGN_ENTITLEMENTS').allMatches(pbxproj), hasLength(runner.length));
      expect(File('ios/Runner/Runner.entitlements').existsSync(), isTrue);
    });

    test('DEVELOPMENT_TEAM bila ada adalah Team ID dari Xcode, bukan nilai contoh', () {
      final teams = RegExp(
        r'"?DEVELOPMENT_TEAM(?:\[[^\]]*\])?"? = "?([^";]*)"?;',
      ).allMatches(pbxproj).map((match) => match.group(1)!).toList();
      // Nilai contoh yang sering tersalin dari panduan dan deret yang jelas bukan Team ID.
      const samples = {'ABCDE12345', '1234567890', '0987654321'};
      for (final team in teams) {
        expect(team, matches(RegExp(r'^[A-Z0-9]{10}$')), reason: 'Team ID Apple 10 karakter');
        expect(samples, isNot(contains(team)), reason: team);
        expect(team, isNot(anyOf(contains('TEAM'), contains('XXXX'), matches(RegExp(r'^(.)\1+$')))), reason: team);
      }
    });
  });
}
