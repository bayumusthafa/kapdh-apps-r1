import '../core/auth/session.dart';

/// Rute awal per effective_status (PRD 2.2). Server tetap menegakkan izin di setiap endpoint.
const _publicRoutes = {'/login', '/register', '/register/otp', '/forgot'};

const _allowedByStatus = <String, Set<String>>{
  'pending_otp': {'/register/otp'},
  'unverified': {'/onboarding', '/kta', '/settings'},
  'verified': {'/home', '/kta', '/settings'},
  'expiring': {'/home', '/kta', '/settings'},
  'expired': {'/renewal', '/kta', '/settings'},
  'suspended': {'/restricted', '/settings'},
  'disabled': {'/deletion'},
  'deletion_pending': {'/deletion'},
};

const _homeByStatus = <String, String>{
  'pending_otp': '/register/otp',
  'unverified': '/onboarding',
  'verified': '/home',
  'expiring': '/home',
  'expired': '/renewal',
  'suspended': '/restricted',
  'disabled': '/deletion',
  'deletion_pending': '/deletion',
};

String? redirectFor(SessionState session, String location) {
  switch (session.phase) {
    case SessionPhase.unknown:
      return location == '/splash' ? null : '/splash';
    case SessionPhase.anonymous:
      if (location == '/register/otp' && session.challenge == null) return '/login';
      return _publicRoutes.contains(location) ? null : '/login';
    case SessionPhase.authenticated:
      final status = session.effectiveStatus ?? 'unverified';
      final allowed = _allowedByStatus[status] ?? const {};
      if (allowed.any((r) => location == r || location.startsWith('$r/'))) return null;
      return _homeByStatus[status] ?? '/login';
  }
}
