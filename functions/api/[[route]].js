/**
 * isdet-tools — Worker Gateway
 * Cloudflare Pages Function (catch-all route)
 *
 * Rotas:
 *   GET  /api/:namespace/:key   → lê um valor
 *   PUT  /api/:namespace/:key   → escreve um valor
 *   DELETE /api/:namespace/:key → remove um valor
 *   GET  /api/:namespace        → lista todas as chaves do namespace
 *
 * Auth: header "Authorization: Bearer <ISDET_TOOLS_API_TOKEN>"
 */

const CORS_ORIGIN = "https://tools.isdet.net";

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed =
    origin === CORS_ORIGIN ||
    origin.endsWith(".pages.dev") || // previews do Cloudflare Pages
    origin === "https://claude.ai";  // acesso dentro do claude.ai
  return allowed ? origin : CORS_ORIGIN;
}

function response(body, status = 200, request = null) {
  const origin = request ? cors(request) : CORS_ORIGIN;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function unauthorized(request) {
  return response({ error: "Unauthorized" }, 401, request);
}

function badRequest(msg, request) {
  return response({ error: msg }, 400, request);
}

function notFound(request) {
  return response({ error: "Not found" }, 404, request);
}

// ─── Cloudflare Access JWT validation ────────────────────────────────────────
// Verifies the JWT that Cloudflare Access adds to every forwarded request.
// Uses Web Crypto (available in Workers) — no npm packages needed.
async function verifyAccessJWT(request, env) {
  if (!env.CF_TEAM_DOMAIN || !env.CF_POLICY_AUD) return false;

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const [headerB64, payloadB64, sigB64] = parts;
    const b64 = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

    const header = JSON.parse(b64(headerB64));
    const payload = JSON.parse(b64(payloadB64));

    if (payload.exp < Date.now() / 1000) return false;

    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(env.CF_POLICY_AUD)) return false;

    if (payload.iss !== env.CF_TEAM_DOMAIN) return false;

    const res = await fetch(`${env.CF_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!res.ok) return false;
    const { keys } = await res.json();

    const jwk = keys.find((k) => k.kid === header.kid) ?? keys[0];
    if (!jwk) return false;

    // Support both RSA (RS256) and EC (ES256) signing keys
    const algo =
      jwk.kty === "EC"
        ? { import: { name: "ECDSA", namedCurve: jwk.crv || "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } }
        : { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: "RSASSA-PKCS1-v1_5" };

    const cryptoKey = await crypto.subtle.importKey("jwk", jwk, algo.import, false, ["verify"]);
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = Uint8Array.from(b64(sigB64), (c) => c.charCodeAt(0));

    return crypto.subtle.verify(algo.verify, cryptoKey, sig, data);
  } catch {
    return false;
  }
}

// Accepts either a Bearer token (programmatic / Claude.ai access)
// or a Cloudflare Access JWT (browser access through tools.isdet.net).
async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token && token === env.ISDET_TOOLS_API_TOKEN) return true;

  return verifyAccessJWT(request, env);
}

export async function onRequest(context) {
  const { request, env, params } = context;

  // Preflight CORS
  if (request.method === "OPTIONS") {
    return response({}, 204, request);
  }

  // Auth
  if (!await authenticate(request, env)) {
    return unauthorized(request);
  }

  // Inicializa tabela se necessário
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS store (
      namespace TEXT NOT NULL,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, key)
    )
  `);

  // Extrai segmentos: /api/:namespace/:key?
  const segments = (params.route || []).filter(Boolean);
  const namespace = segments[0];
  const key = segments[1];

  if (!namespace) {
    return badRequest("namespace required", request);
  }

  // Sanitiza namespace e key (só alfanumérico, hífen e underscore)
  const safe = /^[a-zA-Z0-9_-]+$/;
  if (!safe.test(namespace) || (key && !safe.test(key))) {
    return badRequest("invalid namespace or key", request);
  }

  const method = request.method;

  // GET /api/:namespace → lista chaves
  if (method === "GET" && !key) {
    const { results } = await env.DB.prepare(
      "SELECT key, updated_at FROM store WHERE namespace = ? ORDER BY updated_at DESC"
    )
      .bind(namespace)
      .all();
    return response({ namespace, keys: results }, 200, request);
  }

  // GET /api/:namespace/:key → lê valor
  if (method === "GET" && key) {
    const row = await env.DB.prepare(
      "SELECT value, updated_at FROM store WHERE namespace = ? AND key = ?"
    )
      .bind(namespace, key)
      .first();
    if (!row) return notFound(request);
    return response(
      { namespace, key, value: JSON.parse(row.value), updated_at: row.updated_at },
      200,
      request
    );
  }

  // PUT /api/:namespace/:key → escreve valor
  if (method === "PUT" && key) {
    let body;
    try {
      body = await request.json();
    } catch {
      return badRequest("invalid JSON body", request);
    }

    const now = Date.now();
    const serialized = JSON.stringify(body.value ?? body);

    await env.DB.prepare(
      `INSERT INTO store (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
      .bind(namespace, key, serialized, now)
      .run();

    return response({ ok: true, namespace, key, updated_at: now }, 200, request);
  }

  // DELETE /api/:namespace/:key → remove valor
  if (method === "DELETE" && key) {
    await env.DB.prepare(
      "DELETE FROM store WHERE namespace = ? AND key = ?"
    )
      .bind(namespace, key)
      .run();
    return response({ ok: true, namespace, key }, 200, request);
  }

  return response({ error: "Method not allowed" }, 405, request);
}
