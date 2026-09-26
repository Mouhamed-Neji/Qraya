import { handle, json, bad, readJson, clientIp } from "../lib/http.js";
import { activeProvider, callJson, providerStatus } from "../lib/llm.js";
import { COURSE_SCHEMA, analysePrompt, chunkText, mergeAnalyses, normaliseCourse } from "../lib/prompts.js";
import { LIMITS, checkRate, countUsage, cacheKey, cacheGet, cacheSet } from "../lib/limits.js";

/**
 * POST /api/analyse
 * body: { text, meta:{ fileName, pages, size, lowConfidence, author } }
 * -> { ok, course, ai:{provider,label,model}, parts, ms }
 *
 * Returns 503 { reason:"no-provider" } when no LLM key is configured; the client
 * then falls back to its own on-device engine, so the site still works key-free.
 */
export default handle(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return bad("method-not-allowed", 405);

  const status = providerStatus();
  if (!status.ai) {
    return json({ ok: false, reason: "no-provider", message: "No AI provider configured; use the on-device engine." }, 503);
  }

  let body;
  try {
    body = await readJson(request);
  } catch (err) {
    return bad(err.message, err.status || 400);
  }

  const text = String(body.text || "").trim();
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};

  if (text.length < 200) return bad("text-too-short", 422, { message: "Not enough text to analyse." });
  if (text.length > LIMITS.maxTextChars) {
    return bad("text-too-long", 413, {
      message: `Document is ${text.length} characters; the limit is ${LIMITS.maxTextChars}.`,
      limit: LIMITS.maxTextChars,
    });
  }

  const ip = clientIp(request);
  const rate = checkRate(ip);
  if (!rate.ok) {
    return json({ ok: false, reason: "rate-limited", scope: rate.scope, error: rate.message }, 429, {
      "retry-after": String(rate.retryAfter || 3600),
    });
  }

  const key = cacheKey("analyse", `${status.provider}|${text}`);
  const cached = cacheGet(key);
  if (cached) return json({ ...cached, cached: true });

  try {
    const chars = text.length;
    const chunks = chunkText(text);
    const parts = [];

    for (let i = 0; i < chunks.length; i++) {
      const info = chunks.length > 1 ? { index: i + 1, total: chunks.length } : null;
      const { data } = await callJson({
        system: systemPrompt(),
        user: analysePrompt(chunks[i], meta, info),
        schema: COURSE_SCHEMA,
        maxTokens: Number(process.env.ANALYSE_MAX_TOKENS || 6000),
        temperature: 0.2,
      });
      countUsage();
      parts.push(data);
      if (parts.reduce((n, p) => n + (p?.chapters || []).reduce((m, c) => m + (c.concepts || []).length, 0), 0) > 220) break; // plenty
    }

    const merged = mergeAnalyses(parts, { ...meta, charCount: chars });
    if (!merged.chapters.length) {
      return json({ ok: false, reason: "not-enough-content", message: "This course doesn't contain enough clear information for a full quiz." }, 422);
    }

    const course = normaliseCourse(merged, { ...meta, charCount: chars }, { provider: status.provider, model: status.model });
    const payload = { ok: true, course, ai: { provider: status.provider, label: status.label, model: status.model }, parts: chunks.length };
    cacheSet(key, payload);
    return json(payload);
  } catch (err) {
    return json(
      {
        ok: false,
        reason: err?.reason || "ai-error",
        error: String(err?.message || err).slice(0, 400),
        fallback: true,
      },
      err?.status && err.status >= 400 && err.status < 600 ? err.status : 502
    );
  }
});

function systemPrompt() {
  return `You extract the study structure of a course document for a revision app.

Absolute rules:
- Use ONLY the material given. Never add outside facts, never invent a definition,
  a formula, a date or a number that the text does not support.
- Keep the exact language of the source material (French stays French, Arabic stays
  Arabic, English stays English). In mixed documents keep the original technical
  terms instead of translating them.
- Preserve mathematical notation, symbols and units exactly as written.
- Rebuild the document's real chapter structure, in order.
- Output ONLY the JSON object: no markdown fences, no headings, no commentary.`;
}
