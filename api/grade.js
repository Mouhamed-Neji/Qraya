import { handle, json, bad, readJson, clientIp } from "../lib/http.js";
import { callJson, providerStatus } from "../lib/llm.js";
import { GRADE_SCHEMA, gradePrompt } from "../lib/prompts.js";
import { checkRate, countUsage } from "../lib/limits.js";

/**
 * POST /api/grade
 * body: { lang, items:[{ id, prompt, expected, answer }] }
 * -> { ok, results:[{ id, correct, explanation, missing }] }
 *
 * Only used for short-answer questions — multiple choice and true/false are graded
 * on-device because the answer key is already exact. Returns 503 with no key so
 * the client can fall back to its local keyword grading.
 */
export default handle(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return bad("method-not-allowed", 405);

  const status = providerStatus();
  if (!status.ai) return json({ ok: false, reason: "no-provider" }, 503);

  let body;
  try {
    body = await readJson(request);
  } catch (err) {
    return bad(err.message, err.status || 400);
  }

  const items = (Array.isArray(body.items) ? body.items : [])
    .slice(0, 15)
    .map(i => ({
      id: String(i?.id || "").slice(0, 60),
      prompt: String(i?.prompt || "").slice(0, 900),
      expected: String(i?.expected || "").slice(0, 400),
      answer: String(i?.answer || "").slice(0, 600),
    }))
    .filter(i => i.id && i.expected);

  if (!items.length) return bad("missing-items", 400);

  const rate = checkRate(clientIp(request));
  if (!rate.ok) return json({ ok: false, reason: "rate-limited" }, 429);

  const lang = ["fr", "ar", "en"].includes(body.lang) ? body.lang : "fr";

  try {
    const { data } = await callJson({
      system: `You correct short answers in a school revision app. Judge meaning, not
wording. Be consistent and strict about content, generous about phrasing.
Never invent requirements that the expected answer does not contain.
Output ONLY the JSON object.`,
      user: gradePrompt(items, lang),
      schema: GRADE_SCHEMA,
      maxTokens: 2500,
      temperature: 0.1,
    });
    countUsage();

    // Reconcile: the client must be able to trust every id it sent.
    const byId = new Map((data.results || []).map(r => [String(r.id), r]));
    const results = items.map(i => {
      const r = byId.get(i.id);
      return {
        id: i.id,
        correct: !!r?.correct,
        explanation: String(r?.explanation || "").slice(0, 600),
        missing: Array.isArray(r?.missing) ? r.missing.slice(0, 5).map(String) : [],
      };
    });

    return json({ ok: true, results, ai: { provider: status.provider, model: status.model } });
  } catch (err) {
    return json({ ok: false, reason: err?.reason || "ai-error", error: String(err?.message || err).slice(0, 300) }, err?.status || 502);
  }
});
