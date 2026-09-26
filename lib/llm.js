/* Provider-agnostic LLM client. No SDK, no dependencies — Node 18+ global fetch only.
 *
 * Design goals:
 *  - Free by default: Gemini's free tier is the default provider, but Groq /
 *    OpenRouter / OpenAI / any OpenAI-compatible endpoint work by setting one
 *    env var. Nothing else in the app changes.
 *  - Survive model renames: model ids churn (gemini-2.5-flash -> gemini-3.8-flash).
 *    If the configured model fails we discover what the account actually has via
 *    GET /models and pick a sensible one, then cache it.
 *  - Survive free-tier rate limits: serialised calls + backoff on 429/5xx.
 *  - Survive sloppy JSON: strict schema -> json_object -> raw text, each fallback
 *    step followed by fence stripping + structural repair + validation retry.
 */

/* ------------------------------------------------------------------ config */
const PREF_GEMINI = [/flash-lite/i, /flash/i, /^gemini/i];
const PREF_GENERIC = [/:free/i, /instruct/i, /versatile/i, /chat/i, /./];

export function providers() {
  const custom = process.env.LLM_BASE_URL
    ? {
        id: "custom",
        label: process.env.LLM_LABEL || "Custom endpoint",
        base: process.env.LLM_BASE_URL.replace(/\/+$/, ""),
        key: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "",
        model: process.env.LLM_MODEL || "",
        prefer: PREF_GENERIC,
      }
    : null;

  const list = [
    {
      id: "gemini",
      label: "Google Gemini",
      base: "https://generativelanguage.googleapis.com/v1beta/openai",
      key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
      model: process.env.LLM_MODEL || "gemini-2.5-flash",
      prefer: PREF_GEMINI,
    },
    {
      id: "groq",
      label: "Groq",
      base: "https://api.groq.com/openai/v1",
      key: process.env.GROQ_API_KEY || "",
      model: process.env.LLM_MODEL || "llama-3.3-70b-versatile",
      prefer: [/llama-3\.3-70b/i, /gpt-oss-120b/i, /versatile/i, /llama/i],
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      base: "https://openrouter.ai/api/v1",
      key: process.env.OPENROUTER_API_KEY || "",
      model: process.env.LLM_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
      prefer: [/:free$/i, /llama/i],
    },
    {
      id: "openai",
      label: "OpenAI",
      base: "https://api.openai.com/v1",
      key: process.env.OPENAI_API_KEY || "",
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      prefer: [/mini/i, /4o/i, /gpt/i],
    },
    custom,
  ].filter(Boolean);

  const forced = (process.env.LLM_PROVIDER || "").toLowerCase();
  if (forced) return list.filter(p => p.id === forced);
  return list;
}

/** First provider that has a key. Returns null when the site runs key-free. */
export function activeProvider() {
  return providers().find(p => p.key) || null;
}

export function providerStatus() {
  const p = activeProvider();
  return {
    ai: !!p,
    provider: p ? p.id : null,
    label: p ? p.label : null,
    // Discovered model wins; a provider with no configured model reports null
    // until its first call resolves one.
    model: p ? resolvedModel.get(p.id) || p.model || null : null,
  };
}

/* ------------------------------------------------------------------ models */
const resolvedModel = new Map();

async function discoverModel(p) {
  const res = await fetchWithTimeout(`${p.base}/models`, { headers: authHeaders(p) }, 20000);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const ids = (body?.data || body?.models || [])
    .map(m => (typeof m === "string" ? m : m?.id || m?.name))
    .filter(Boolean)
    .map(id => String(id).replace(/^models\//, ""))
    .filter(id => !/embed|image|tts|audio|vision-|veo|aqa|gemma/i.test(id));
  if (!ids.length) return null;
  for (const rx of p.prefer) {
    const hit = ids.find(id => rx.test(id));
    if (hit) return hit;
  }
  return ids[0];
}

async function modelFor(p, { refresh = false } = {}) {
  if (!refresh && resolvedModel.has(p.id)) return resolvedModel.get(p.id);
  const m = p.model || (await discoverModel(p)) || "gemini-2.5-flash";
  resolvedModel.set(p.id, m);
  return m;
}

function authHeaders(p) {
  const h = { "content-type": "application/json", authorization: `Bearer ${p.key}` };
  if (p.id === "openrouter") {
    h["http-referer"] = process.env.PUBLIC_SITE_URL || "https://qraya.vercel.app";
    h["x-title"] = "Qraya";
  }
  return h;
}

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ concurrency */
// Free tiers are small (Gemini ~10-15 RPM, Groq ~30 RPM / 8-12k TPM). Serialising
// keeps a burst of students from turning into 429s.
const MAX_PARALLEL = Math.max(1, Number(process.env.LLM_CONCURRENCY || 1));
let running = 0;
const queue = [];
function gate() {
  if (running < MAX_PARALLEL) {
    running++;
    return Promise.resolve(() => { running--; pump(); });
  }
  return new Promise(resolve => queue.push(() => { running++; resolve(() => { running--; pump(); }); }));
}
function pump() {
  while (running < MAX_PARALLEL && queue.length) queue.shift()();
}

/* ------------------------------------------------------------------- json */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json|JSON)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const first = s.search(/[[{]/);
  if (first > 0) s = s.slice(first);
  const last = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (last >= 0) s = s.slice(0, last + 1);
  try {
    return JSON.parse(s);
  } catch {}
  try {
    const repaired = s
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\n(?=[^"]*"[^"]*$)/g, "\\n");
    return JSON.parse(repaired);
  } catch {}
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ------------------------------------------------------------------- call */
/**
 * Ask the model for a JSON object matching `schema`.
 * Falls back: json_schema -> json_object -> plain text, and retries once when the
 * result is structurally invalid.
 *
 * @returns {{data:object, model:string, provider:string, usage:object|null, ms:number}}
 */
export async function callJson({ system, user, schema, maxTokens = 4000, temperature = 0.4, attempts = 3 }) {
  const p = activeProvider();
  if (!p) throw Object.assign(new Error("no-provider"), { status: 503, reason: "no-provider" });

  const release = await gate();
  const started = Date.now();
  try {
    let model = await modelFor(p);
    let lastError = null;
    let allowSchema = true;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const modes = allowSchema ? ["json_schema", "json_object", "text"] : ["json_object", "text"];
      let data = null;
      let raw = "";
      let usage = null;

      for (const mode of modes) {
        const body = {
          model,
          messages: [
            { role: "system", content: buildSystem(system, schema, mode) },
            { role: "user", content: user },
          ],
          temperature,
          max_tokens: maxTokens,
        };
        if (mode === "json_schema") body.response_format = { type: "json_schema", json_schema: { name: "qraya", schema, strict: false } };
        if (mode === "json_object") body.response_format = { type: "json_object" };

        let res;
        try {
          res = await fetchWithTimeout(`${p.base}/chat/completions`, { method: "POST", headers: authHeaders(p), body: JSON.stringify(body) }, Number(process.env.LLM_TIMEOUT_MS || 110000));
        } catch (err) {
          lastError = new Error(`network: ${err.message}`);
          break;
        }

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after"));
          lastError = new Error(`provider ${res.status}`);
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 15000) : Math.min(1500 * 2 ** attempt, 12000));
          break; // retry the whole attempt
        }

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          lastError = new Error(`provider ${res.status}: ${detail.slice(0, 300)}`);
          if (/response_format|json_schema|json mode|unsupported/i.test(detail) && mode !== "text") {
            if (mode === "json_schema") allowSchema = false; // never try the schema again
            continue; // try the next, weaker mode
          }
          if (res.status === 404 && model) {
            model = await modelFor(p, { refresh: true });
            lastError = new Error(`model unavailable, retrying with ${model}`);
            break;
          }
          throw Object.assign(lastError, { status: res.status });
        }

        const payload = await res.json().catch(() => null);
        usage = payload?.usage || null;
        raw = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? "";
        if (Array.isArray(raw)) raw = raw.map(x => x?.text || "").join("");
        data = extractJson(raw);
        if (data && validate(data, schema)) break;
        data = null;
      }

      if (data && validate(data, schema)) {
        return { data, model, provider: p.id, label: p.label, usage, ms: Date.now() - started };
      }

      // Last resort: tell the model what went wrong and ask again.
      if (attempt < attempts - 1) {
        await sleep(600 * (attempt + 1));
        user = `${user}\n\nIMPORTANT: your previous answer was not valid JSON matching the required schema. Reply with ONLY the JSON object, no prose, no markdown fences.`;
      }
    }
    throw Object.assign(lastError || new Error("invalid-model-output"), { status: 502 });
  } finally {
    release();
  }
}

function buildSystem(system, schema, mode) {
  if (mode === "json_schema") return system;
  const shape = JSON.stringify(schema, null, 0);
  return `${system}\n\nReply with a single JSON object that strictly matches this JSON Schema (no markdown fences, no commentary):\n${shape}`;
}

/* --------------------------------------------------------------- validate */
/** Minimal structural validation against the subset of JSON Schema we emit. */
export function validate(value, schema, path = "$") {
  if (!schema) return true;
  const t = schema.type;
  if (t === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    for (const key of schema.required || []) if (value[key] === undefined || value[key] === null) return false;
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (value[k] === undefined) continue;
      if (!validate(value[k], sub, `${path}.${k}`)) return false;
    }
    return true;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.minItems && value.length < schema.minItems) return false;
    return value.every((v, i) => validate(v, schema.items, `${path}[${i}]`));
  }
  if (t === "string") return typeof value === "string";
  if (t === "boolean") return typeof value === "boolean";
  if (t === "number" || t === "integer") return typeof value === "number" && Number.isFinite(value);
  if (schema.enum) return schema.enum.includes(value);
  return true;
}

/** One call, no schema validation retries — used when the caller handles shape. */
export async function callText({ system, user, maxTokens = 2000, temperature = 0.3 }) {
  const p = activeProvider();
  if (!p) throw Object.assign(new Error("no-provider"), { status: 503, reason: "no-provider" });
  const release = await gate();
  try {
    const model = await modelFor(p);
    const res = await fetchWithTimeout(
      `${p.base}/chat/completions`,
      {
        method: "POST",
        headers: authHeaders(p),
        body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature, max_tokens: maxTokens }),
      },
      Number(process.env.LLM_TIMEOUT_MS || 110000)
    );
    if (!res.ok) throw Object.assign(new Error(`provider ${res.status}`), { status: 502 });
    const payload = await res.json().catch(() => null);
    return { text: payload?.choices?.[0]?.message?.content || "", model, provider: p.id };
  } finally {
    release();
  }
}
