#!/usr/bin/env node
/* Qraya local server — zero dependencies.
 *
 *   cp .env.example .env     # optional: paste a free Gemini key
 *   node dev-server.mjs      # http://localhost:3000
 *
 * Serves public/ as the website and api/*.js as the backend, exactly like
 * Vercel does in production. Without an AI key everything still works: the
 * browser falls back to its built-in on-device question engine.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

/* ------------------------------------------------------------------ .env */
function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

/* --------------------------------------------------------------- serving */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const staticRoot = path.join(__dirname, "public");

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.join(staticRoot, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(staticRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA-style fallback: unknown paths return the app
    const fallback = path.join(staticRoot, "index.html");
    if (fs.existsSync(fallback)) {
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
      fs.createReadStream(fallback).pipe(res);
      return;
    }
    res.writeHead(404, { "content-type": MIME[".txt"] });
    res.end("404 Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=60",
  });
  fs.createReadStream(filePath).pipe(res);
}

const modules = new Map();
async function loadRoute(name) {
  if (!modules.has(name)) {
    const file = path.join(__dirname, "api", `${name}.js`);
    if (!fs.existsSync(file)) return null;
    modules.set(name, await import(pathToFileURL(file).href));
  }
  return modules.get(name);
}

/* Vercel hands the default export a Web Request; the same contract works here. */
async function toRequest(req, base) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else headers.set(k, String(v));
  }
  return new Request(new URL(base), {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" || !body.length ? undefined : body,
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  const base = `http://localhost:${PORT}${req.url === "/" ? "/" : req.url}`;

  if (urlPath.startsWith("/api/")) {
    const name = urlPath.slice("/api/".length).replace(/\/+$/, "");
    if (!/^[a-z0-9-]+$/i.test(name)) {
      res.writeHead(400, { "content-type": MIME[".json"] });
      res.end(JSON.stringify({ ok: false, error: "bad-route" }));
      return;
    }
    const mod = await loadRoute(name);
    if (!mod?.default) {
      res.writeHead(404, { "content-type": MIME[".json"] });
      res.end(JSON.stringify({ ok: false, error: "unknown-endpoint" }));
      return;
    }
    const started = Date.now();
    try {
      const request = await toRequest(req, base);
      const response = await mod.default(request);
      const buf = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers.entries()),
        "x-response-time": `${Date.now() - started}ms`,
      });
      res.end(buf);
      console.log(`${req.method} /api/${name} -> ${response.status} (${Date.now() - started}ms)`);
    } catch (err) {
      console.error(`API error on /api/${name}:`, err);
      res.writeHead(500, { "content-type": MIME[".json"] });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    }
    return;
  }

  serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  const gemini = !!process.env.GEMINI_API_KEY;
  const groq = !!process.env.GROQ_API_KEY;
  const openrouter = !!process.env.OPENROUTER_API_KEY;
  const openai = !!process.env.OPENAI_API_KEY;
  const any = gemini || groq || openrouter || openai || process.env.LLM_API_KEY;
  console.log(`\n  Qraya  →  http://localhost:${PORT}\n`);
  console.log(any ? "  AI backend: ON (real model calls enabled)" : "  AI backend: OFF — no key found, the app uses its built-in engine");
  console.log(any ? "" : "  Add a free key to .env to enable AI (see .env.example)\n");
});
