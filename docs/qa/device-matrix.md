# KAPDH Apps R1.0: device and browser matrix (N-12, D7)

Phase D hardening, findings D2-10 (N-12), D2-11 (N-11) and D2-13 (N-03). This file records the target platform
matrix that D7 locks, how the build enforces it, the automated device smoke, and the runs done so far. UAT group
U-13 (PRD 9.1) completes the open rows.

## 1. Locked matrix (PRD v3.5 D7, ratified)

| Client | Minimum | Upper bound | Enforced by |
| --- | --- | --- | --- |
| Android app | Android 8.0 (API 26) | latest stable Android | `kapdh-mobile/android/app/build.gradle.kts` `minSdk = 26` |
| iOS app | iOS 15.0 | latest stable iOS | `ios/Podfile` `platform :ios, '15.0'`; `IPHONEOS_DEPLOYMENT_TARGET = 15.0` in every Runner build configuration |
| Admin web, public web | last two stable versions of Chrome, Edge, Firefox and Safari (desktop) | latest stable | no build-time check (see section 5) |

`kapdh-mobile/test/platform/d7_platform_matrix_test.dart` ("N-12, D7: versi OS minimum") fails when the Android or
iOS minimum drifts from D7. A change to the minimum needs a D7 change first.

## 2. Test targets per release candidate

Each row is one target that must pass the smoke in section 3 before sign-off. "Min" covers the oldest OS that D7
promises; "Latest" covers the current OS on current hardware.

| Target | Device | Why |
| --- | --- | --- |
| Android min | physical Android 8.0 / 8.1 device, 2-3 GB RAM | oldest supported OS and a low-end CPU (N-03 worst case) |
| Android latest | Pixel-class device or emulator on the latest Android | current OS behaviour (permissions, edge-to-edge) |
| iOS min | iPhone on iOS 15 (device or simulator) | oldest supported iOS |
| iOS latest | iPhone on the latest iOS | current OS behaviour |
| Admin/web | Chrome, Edge, Firefox, Safari: current and previous stable, desktop | N-12 browsers |

## 3. Mobile device smoke: `kapdh-mobile/integration_test/critical_flows_test.dart`

It runs the real app (router, redirect, gates, session) on the device. API responses come from an in-process
fake, so no backend is needed and every target runs the same smoke. It covers:

- **Login and secure storage.** Login saves the session to the real Android Keystore / iOS Keychain. A new app
  instance restores the session from it. Logout removes the token, `/me` snapshot, Home cache, KTA cache and
  idempotency keys from device storage (PRD 5.2).
- **KTA.** The active card with its member number and QR renders on the device screen.
- **Payment proof.** Pick a proof, upload it and submit; the screen shows "Menunggu Verifikasi" (AC F03-2).
- **N-03 on the device.** p50/p95 time to first usable content for Home, KTA and News, from a cold start with a
  stored session and no cache. Each request is delayed per the N-03 network profile (10 Mbps, 100 ms RTT, TCP + TLS
  1.3 handshake on the first connection) plus the N-01 server p95 (500 ms). The device wall clock measures render
  and parse cost on real hardware. Results go to `binding.reportData['n03_first_content_ms']` and the log
  (`N-03 perangkat ...`).

Run on a connected device or emulator:

```sh
cd kapdh-mobile
flutter devices
flutter test integration_test/critical_flows_test.dart -d <device-id>                       # 20 samples per screen
flutter test integration_test/critical_flows_test.dart -d <device-id> --dart-define=N03_SAMPLES=50
```

The same N-03 model also runs on the host in every `flutter test` (`test/perf/first_content_n03_test.dart`), with
the Flutter fake clock. The host run catches request waterfalls and screens that never finish loading. The device
run adds real render cost. A staging measurement with real network shaping and the real server is still a UAT
item.

## 4. Run record

| Date | Target | Result | N-03 p95 (Home / KTA / News) | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-14 | Android latest: emulator (AVD Pixel 8, Android 15 / API 35, x86_64, 2 GB RAM) | pass: smoke (login with Keystore, session restore, logout wipe; KTA; payment proof) and N-03, `flutter drive --profile`, n=20 per screen | 1888 / 1928 / 1963 ms (p50 1796 / 1784 / 1787 ms) | commit 4cdcc67 (logout also evicts decoded private images); Windows build host |
| 2026-10-14 | Android latest: same emulator | pass: smoke and N-03, `flutter drive --profile`, n=20 per screen | 2245 / 2070 / 2073 ms (p50 2038 / 1946 / 1856 ms) | commit eb2547f |
| pending | Android min (8.0 physical) | not run | - | no API 26 device or system image on the build machine |
| pending | iOS min / latest | not run | - | needs macOS + Xcode; run on the Mac build host before sign-off |
| pending | Admin/web browsers | not run | - | Playwright smoke not yet added (admin/web area, see section 5) |

Emulator figures are indicative only. The x86_64 emulator runs on a desktop CPU, so it does not stand for a low-end
Android 8 phone, and the build machine is shared, so host load moves the numbers. A development run on the same
emulator before commit eb2547f measured Home p95 4.6 s (KTA 3.9 s, News 2.8 s); its cause was not recorded. On
2026-10-14 one attempt also stopped during the payment smoke because the emulator process exited (`adb: device
offline`); the retry on a fresh boot is the passing row above. The N-03 sign-off number comes from the Android min
physical device.

## 5. Open items for U-13

- **Physical Android 8.0 and iOS 15 / latest runs** of section 3, recorded in section 4.
- **Browser smoke for admin and public web.** There is no Playwright (Chromium, Firefox, WebKit) smoke yet, and
  Edge/Chrome previous-stable runs are manual. This belongs to the admin/web area.
- **Manual screen-reader pass (N-11).** TalkBack on the Android target and VoiceOver on the iOS target over
  register/OTP, login, KTA, payment proof and chat, plus NVDA on admin. Record it in the UAT report.
  Automated checks already run in `flutter test`: `meetsGuideline` (Android/iOS tap target size, labelled tap
  targets, text contrast) on login, register, OTP, KTA, payment proof (instructions, awaiting review, rejected,
  proof viewer), chat and the restricted portal (`test/support/a11y.dart`, tests named
  "N-11: pedoman aksesibilitas otomatis ...").
- **Automated a11y audit in admin (N-11).** Admin page tests have no axe (`vitest-axe`) check yet. This belongs to
  the admin area.
- **N-03 on staging.** p95 with real network shaping (10 Mbps / 100 ms) against the staging API on the Android min
  target.
