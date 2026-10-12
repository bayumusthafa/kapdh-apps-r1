import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/redirect.dart';
import 'package:kapdh_mobile/core/auth/session.dart';

void main() {
  SessionState authed(String status) => SessionState.authenticated(status, const {});

  test('anonim hanya boleh di layar publik', () {
    expect(redirectFor(const SessionState.anonymous(), '/home'), '/login');
    expect(redirectFor(const SessionState.anonymous(), '/register'), isNull);
  });
  test('OTP tanpa challenge kembali ke login', () {
    expect(redirectFor(const SessionState.anonymous(), '/register/otp'), '/login');
  });
  test('rute awal per effective_status (PRD 2.2)', () {
    expect(redirectFor(authed('unverified'), '/login'), '/onboarding');
    expect(redirectFor(authed('verified'), '/login'), '/home');
    expect(redirectFor(authed('expired'), '/home'), '/renewal');
    expect(redirectFor(authed('suspended'), '/kta'), '/restricted');
  });
  test('unverified boleh melihat KTA tidak aktif', () {
    expect(redirectFor(authed('unverified'), '/kta'), isNull);
  });
}
