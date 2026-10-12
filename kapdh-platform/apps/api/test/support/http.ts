import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/** Opsi request uji: token Bearer, header tambahan, cookie. */
export interface RequestOptions {
  token?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  query?: Record<string, string>;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Klien HTTP uji di atas `app.inject` dengan prefix /api/v1:
 *
 *   const api = httpClient(app);
 *   const res = await api.post("/auth/login", { email, password });
 *   const me = await api.get("/me", { token });
 */
export function httpClient(app: NestFastifyApplication) {
  const call = (method: Method, url: string, payload: unknown, options: RequestOptions = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      ...(options.cookies ? { cookies: options.cookies } : {}),
      ...(options.query ? { query: options.query } : {}),
    });
  return {
    get: (url: string, options?: RequestOptions) => call("GET", url, undefined, options),
    delete: (url: string, options?: RequestOptions) => call("DELETE", url, undefined, options),
    post: (url: string, body: unknown = {}, options?: RequestOptions) => call("POST", url, body, options),
    put: (url: string, body: unknown = {}, options?: RequestOptions) => call("PUT", url, body, options),
    patch: (url: string, body: unknown = {}, options?: RequestOptions) => call("PATCH", url, body, options),
  };
}

export type HttpClient = ReturnType<typeof httpClient>;
