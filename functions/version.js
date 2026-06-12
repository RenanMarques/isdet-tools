export function onRequest({ env }) {
  const sha = env.CF_PAGES_COMMIT_SHA || "dev";
  return new Response(JSON.stringify({ sha }), {
    headers: { "Content-Type": "application/json" },
  });
}
