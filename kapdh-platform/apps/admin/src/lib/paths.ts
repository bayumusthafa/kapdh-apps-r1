import type { RegisteredRouter } from "@tanstack/react-router";

/** Semua path rute web admin yang terdaftar (ARCHITECTURE §7), diturunkan dari pohon rute bertipe. */
export type AppPath = keyof RegisteredRouter["routesByPath"] & string;

/** Path tanpa parameter dinamis, aman dipakai sebagai tautan statis (menu, breadcrumb). */
export type StaticAppPath = Exclude<AppPath, `${string}$${string}`>;
