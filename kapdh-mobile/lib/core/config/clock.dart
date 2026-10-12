/// Sumber waktu yang dapat diganti pada uji. Logika klien (TTL cache, cooldown OTP) memakai waktu ini; status
/// keanggotaan tetap dihitung server (PRD 2.1, 2.2).
typedef Clock = DateTime Function();

DateTime systemClock() => DateTime.now();
