/**
 * isdet-tools — Worker Gateway
 * Cloudflare Pages Function (catch-all route)
 *
 * Routes:
 *   GET    /api/:namespace/:collection        → list records from the collection
 *   GET    /api/:namespace/:collection/:id    → read a record
 *   PUT    /api/:namespace/:collection/:id    → upsert a record (OCC via If-Match)
 *   DELETE /api/:namespace/:collection/:id    → remove a record
 *
 * Auth: header "Authorization: Bearer <ISDET_TOOLS_API_TOKEN>"
 *       or Cloudflare Access JWT
 *
 * OCC headers (PUT):
 *   If-Match: <version>      — expected current version on server; 409 if mismatch
 *   X-New-Version: <version> — version to store after successful write
 */

const CORS_ORIGIN = "https://tools.isdet.net";

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed =
    origin === CORS_ORIGIN ||
    origin.endsWith(".pages.dev") ||
    origin === "https://claude.ai";
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-New-Version",
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

async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token && token === env.ISDET_TOOLS_API_TOKEN) return true;

  return verifyAccessJWT(request, env);
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") {
    return response({}, 204, request);
  }

  if (!await authenticate(request, env)) {
    return unauthorized(request);
  }

  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS records (
      namespace  TEXT    NOT NULL,
      collection TEXT    NOT NULL,
      id         TEXT    NOT NULL,
      data       TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, collection, id)
    )
  `);

  // Additive migration: add version column if it doesn't exist yet
  try {
    await env.DB.exec("ALTER TABLE records ADD COLUMN version TEXT");
  } catch {}

  const segments = (params.route || []).filter(Boolean);
  const namespace  = segments[0];
  const collection = segments[1];
  const id         = segments[2];

  if (!namespace || !collection) {
    return badRequest("namespace and collection required", request);
  }

  const safe = /^[a-zA-Z0-9_-]+$/;
  if (!safe.test(namespace) || !safe.test(collection) || (id && !safe.test(id))) {
    return badRequest("invalid namespace, collection or id", request);
  }

  const method = request.method;

  // GET /api/:namespace/:collection → list records
  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare(
      "SELECT id, data, created_at, updated_at, version FROM records WHERE namespace = ? AND collection = ? ORDER BY updated_at DESC"
    )
      .bind(namespace, collection)
      .all();
    return response({
      namespace,
      collection,
      records: results.map((r) => ({
        id: r.id,
        data: JSON.parse(r.data),
        created_at: r.created_at,
        updated_at: r.updated_at,
        version: r.version ?? null,
      })),
    }, 200, request);
  }

  // GET /api/:namespace/:collection/:id → read a record
  if (method === "GET" && id) {
    const row = await env.DB.prepare(
      "SELECT data, created_at, updated_at, version FROM records WHERE namespace = ? AND collection = ? AND id = ?"
    )
      .bind(namespace, collection, id)
      .first();
    if (!row) return notFound(request);
    return response(
      {
        namespace, collection, id,
        data: JSON.parse(row.data),
        created_at: row.created_at,
        updated_at: row.updated_at,
        version: row.version ?? null,
      },
      200,
      request
    );
  }

  // PUT /api/:namespace/:collection/:id → upsert with optional OCC
  if (method === "PUT" && id) {
    let body;
    try {
      body = await request.json();
    } catch {
      return badRequest("invalid JSON body", request);
    }

    const expectedVersion = request.headers.get("If-Match") || null;
    const newVersion      = request.headers.get("X-New-Version") || null;
    const now             = Date.now();
    const serialized      = JSON.stringify(body);

    // OCC check: if client declares an expected version, verify it matches the server
    if (expectedVersion) {
      const current = await env.DB.prepare(
        "SELECT version FROM records WHERE namespace = ? AND collection = ? AND id = ?"
      )
        .bind(namespace, collection, id)
        .first();

      if (current && current.version !== expectedVersion) {
        return response(
          { error: "conflict", currentVersion: current.version ?? null },
          409,
          request
        );
      }
    }

    await env.DB.prepare(
      `INSERT INTO records (namespace, collection, id, data, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (namespace, collection, id) DO UPDATE SET
         data       = excluded.data,
         updated_at = excluded.updated_at,
         version    = excluded.version`
    )
      .bind(namespace, collection, id, serialized, now, now, newVersion)
      .run();

    const row = await env.DB.prepare(
      "SELECT created_at FROM records WHERE namespace = ? AND collection = ? AND id = ?"
    )
      .bind(namespace, collection, id)
      .first();

    return response(
      { ok: true, namespace, collection, id, created_at: row.created_at, updated_at: now, version: newVersion },
      200,
      request
    );
  }

  // DELETE /api/:namespace/:collection/:id → remove
  if (method === "DELETE" && id) {
    await env.DB.prepare(
      "DELETE FROM records WHERE namespace = ? AND collection = ? AND id = ?"
    )
      .bind(namespace, collection, id)
      .run();
    return response({ ok: true, namespace, collection, id }, 200, request);
  }

  return response({ error: "Method not allowed" }, 405, request);
}
