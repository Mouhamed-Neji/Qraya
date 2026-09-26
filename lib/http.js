/* Portable request helper.
 *
 * The whole API is written against the Web standard (Request -> Response), which
 * is what Vercel passes to a Web handler. The same modules also run under a plain
 * Node http server (dev-server.mjs, and any VPS), so we normalise a Node
 * IncomingMessage into a Request when needed.
 */

export const isWebRequest = x =>
  !!x && typeof x === "object" && typeof x.json === "function" && typeof x.headers?.get === "function";

export async function nodeToWeb(req, origin = "http://localhost") {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else headers.set(k, String(v));
  }
  return new Request(new URL(req.url || "/", origin), {
    method: req.method || "GET",
    headers,
    body: req.method === "GET" || req.method === "HEAD" || !body.length ? undefined : body,
  });
}

/** Wrap a Web-style handler so it also works when handed a Node req/res. */
export const handle = fn => async (a, b) => {
  if (isWebRequest(a)) return fn(a);
  const request = await nodeToWeb(a);
  const response = await fn(request);
  // Node path: write the Response out ourselves.
  if (b && typeof b.writeHead === "function") {
    b.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const buf = Buffer.from(await response.arrayBuffer());
    b.end(buf);
    return;
  }
  return response;
};

export const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });

export const bad = (message, status = 400, extra = {}) => json({ ok: false, error: message, ...extra }, status);

export async function readJson(request, { maxBytes = 3_000_000 } = {}) {
  const raw = await request.text();
  if (raw.length > maxBytes) throw Object.assign(new Error("payload-too-large"), { status: 413 });
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("invalid-json"), { status: 400 });
  }
}

export const clientIp = request =>
  (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
  request.headers.get("x-real-ip") ||
  "local";
