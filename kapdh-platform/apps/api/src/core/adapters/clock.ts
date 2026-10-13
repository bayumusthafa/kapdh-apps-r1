/**
 * Sumber waktu yang bisa diganti di uji (idle timeout, kedaluwarsa OTP, periode keanggotaan, hold kursi).
 * Logika bisnis selalu memakai `clock.now()` (ARCHITECTURE §2.6); kolom peka waktu diisi eksplisit dari Clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
