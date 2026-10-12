/** Sumber waktu yang bisa diganti di uji (idle timeout, kedaluwarsa OTP, periode). */
export const CLOCK = Symbol("CLOCK");
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
