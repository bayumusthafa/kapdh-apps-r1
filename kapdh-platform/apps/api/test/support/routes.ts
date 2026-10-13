/**
 * Inventaris rute Nest beserta deklarasi aksesnya (ARCHITECTURE §4.3): dipakai uji "setiap rute menyatakan @Public
 * atau @Audience" dan pencocokan dekorator server dengan `x-kapdh-access` kontrak.
 */
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { MetadataScanner, ModulesContainer, Reflector } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { type RouteAuthMeta, routeAuthMeta } from "../../src/core/guards/decorators.js";
import { IDEMPOTENT_KEY } from "../../src/core/idempotency/idempotent.js";

export interface RouteAccess {
  /** `Controller.handler`, untuk pesan galat. */
  name: string;
  /** Metode HTTP huruf kecil (get, post, ...). */
  method: string;
  /** Template path tanpa prefix /api/v1 dengan parameter `{nama}`, mis. `/me/payments/{paymentId}`. */
  path: string;
  meta: RouteAuthMeta;
  idempotent: boolean;
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? (value as string[]) : [String(value ?? "")];

function joinPath(base: string, sub: string): string {
  const segments = [base, sub].flatMap((part) => part.split("/")).filter((segment) => segment.length > 0);
  return `/${segments.join("/")}`.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Semua handler HTTP dari controller yang terdaftar di aplikasi (modul domain + modul tambahan uji). */
export function routeAccessList(app: NestFastifyApplication): RouteAccess[] {
  const container = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const routes: RouteAccess[] = [];
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as object;
      const prototype = Object.getPrototypeOf(wrapper.instance) as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as object;
        const handlerPath: unknown = Reflect.getMetadata(PATH_METADATA, handler);
        if (handlerPath === undefined) continue;
        const verb =
          RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod].toLowerCase();
        const meta = routeAuthMeta(reflector, [handler, controller]);
        const idempotent =
          reflector.getAllAndOverride<boolean | undefined>(IDEMPOTENT_KEY, [
            handler as () => unknown,
            controller as new () => unknown,
          ]) === true;
        for (const base of asList(Reflect.getMetadata(PATH_METADATA, controller)))
          for (const sub of asList(handlerPath))
            routes.push({
              name: `${wrapper.name}.${name}`,
              method: verb,
              path: joinPath(base, sub),
              meta,
              idempotent,
            });
      }
    }
  }
  return routes;
}
