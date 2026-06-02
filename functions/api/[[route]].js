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

function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token === env.ISDET_TOOLS_API_TOKEN;
}

export async function onRequest(context) {
  const { request, env, params } = context;

  // Preflight CORS
  if (request.method === "OPTIONS") {
    return response({}, 204, request);
  }

  // Auth
  if (!authenticate(request, env)) {
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
