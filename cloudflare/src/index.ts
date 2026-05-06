export interface Env {
  USER_WEB_ORIGIN: string;
  ADMIN_WEB_ORIGIN: string;
  USER_API_ORIGIN: string;
  ADMIN_API_ORIGIN: string;
  OPENAI_API_ORIGIN: string;
  ADMIN_HOST?: string;
  BUILD_SHA?: string;
  CORS_ALLOW_ORIGINS?: string;
}

const API_PREFIXES = ["/api/", "/admin/api/", "/v1/"] as const;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function normalizeOrigin(raw: string | undefined, name: string): URL {
  if (!raw || raw.includes("example.com")) {
    throw new Error(`Missing Cloudflare Worker var: ${name}`);
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function corsOrigin(request: Request, env: Env): string | null {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return null;

  const configured = (env.CORS_ALLOW_ORIGINS || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (configured.includes("*")) return requestOrigin;
  return configured.includes(requestOrigin) ? requestOrigin : null;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const allowedOrigin = corsOrigin(request, env);
  if (!allowedOrigin) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight(request: Request, env: Env): Response {
  const headers = new Headers();
  const allowedOrigin = corsOrigin(request, env);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    request.headers.get("Access-Control-Request-Headers") || "Authorization,Content-Type",
  );
  headers.set("Access-Control-Max-Age", "86400");
  headers.append("Vary", "Origin");
  return new Response(null, { status: 204, headers });
}

function chooseOrigin(url: URL, env: Env): URL {
  if (url.pathname.startsWith("/v1/")) {
    return normalizeOrigin(env.OPENAI_API_ORIGIN, "OPENAI_API_ORIGIN");
  }
  if (url.pathname.startsWith("/admin/api/")) {
    return normalizeOrigin(env.ADMIN_API_ORIGIN, "ADMIN_API_ORIGIN");
  }
  if (url.pathname.startsWith("/api/")) {
    return normalizeOrigin(env.USER_API_ORIGIN, "USER_API_ORIGIN");
  }

  const adminHost = (env.ADMIN_HOST || "").toLowerCase();
  if (adminHost && url.hostname.toLowerCase() === adminHost) {
    return normalizeOrigin(env.ADMIN_WEB_ORIGIN, "ADMIN_WEB_ORIGIN");
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return normalizeOrigin(env.ADMIN_WEB_ORIGIN, "ADMIN_WEB_ORIGIN");
  }
  return normalizeOrigin(env.USER_WEB_ORIGIN, "USER_WEB_ORIGIN");
}

function buildProxyRequest(request: Request, target: URL): Request {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.set("X-Forwarded-Host", new URL(request.url).host);
  headers.set("X-Forwarded-Proto", "https");

  return new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxy(request: Request, env: Env): Promise<Response> {
  const incoming = new URL(request.url);
  const origin = chooseOrigin(incoming, env);
  const target = new URL(origin.toString());
  target.pathname = `${origin.pathname}${incoming.pathname}`.replace(/\/+/g, "/");
  target.search = incoming.search;

  const response = await fetch(buildProxyRequest(request, target));
  const secured = securityHeaders(response);
  return API_PREFIXES.some((prefix) => incoming.pathname.startsWith(prefix))
    ? withCors(secured, request, env)
    : secured;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return preflight(request, env);
    }

    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "gpt2api-edge",
        build_sha: env.BUILD_SHA || "dev",
      });
    }

    try {
      return await proxy(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown edge error";
      return Response.json({ ok: false, error: message }, { status: 502 });
    }
  },
};
