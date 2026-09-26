import { handle, json, bad, readJson, clientIp } from "../lib/http.js";
import { callJson, providerStatus } from "../lib/llm.js";
import { QUIZ_SCHEMA, quizPrompt, normaliseQuestions, withIds } from "../lib/prompts.js";
import { LIMITS, checkRate, countUsage, cacheKey, cacheGet, cacheSet } from "../lib/limits.js";

const BATCH = Number(process.env.QUIZ_BATCH_SIZE || 8);

/**
 * POST /api/quiz
 * body: { course, config:{count,difficulty,type,scope:{kind,id}}, focus:[concept…], lang }
 * -> { ok, questions:[…], ai:{…} }
 *
 * Questions are requested in small batches: a free tier answers 8 fast, one
 * request for 30 is slow and far more likely to be rate-limited or truncated.
 * Every batch sees the concepts already covered, so the batches do not overlap.
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

  const course = body.course;
  const config = body.config && typeof body.config === "object" ? body.config : {};
  if (!course || !Array.isArray(course.chapters) || !course.chapters.length) return bad("missing-course", 400);

  const count = Math.min(Math.max(1, Number(config.count) || 10), LIMITS.maxQuestions);
  const lang = config.lang && config.lang !== "auto" ? config.lang : course.lang || "fr";
  const scoped = applyScope(course, config.scope);
  if (!scoped.chapters.length) return bad("empty-scope", 422, { message: "No chapter or concept matched this scope." });

  const focus = Array.isArray(body.focus) ? body.focus.filter(Boolean).slice(0, 20).map(String) : [];

  const ip = clientIp(request);
  const rate = checkRate(ip);
  if (!rate.ok) return json({ ok: false, reason: "rate-limited", scope: rate.scope }, 429, { "retry-after": String(rate.retryAfter || 3600) });

  const key = cacheKey("quiz", JSON.stringify({ c: scoped.title, n: count, d: config.difficulty, t: config.type, s: config.scope, l: lang, f: focus, h: fingerprint(scoped) }));
  const cached = cacheGet(key);
  if (cached) return json({ ...cached, cached: true });

  try {
    const questions = [];
    const asked = [];
    let remaining = count;
    let emptyRounds = 0;

    while (remaining > 0 && emptyRounds < 3) {
      const want = Math.min(BATCH, remaining);
      const { data } = await callJson({
        system: systemPrompt(),
        user: quizPrompt(scoped, { ...config, count: want, scope: config.scope }, lang, { focus, avoid: asked }),
        schema: QUIZ_SCHEMA,
        maxTokens: Number(process.env.QUIZ_MAX_TOKENS || 5000),
        temperature: 0.65,
      });
      countUsage();

      // Ask for a couple of spares, then drop anything that repeats a previous batch.
      const batch = normaliseQuestions(data.questions, { count: want + 3, chapters: scoped.chapters, type: config.type });
      const fresh = batch.filter(q => !asked.includes(q.prompt)).slice(0, want);
      if (!fresh.length) emptyRounds++;
      else emptyRounds = 0;

      fresh.forEach(q => {
        asked.push(q.prompt);
        questions.push(q);
      });
      remaining = count - questions.length;
    }

    if (!questions.length) return json({ ok: false, reason: "empty-generation", message: "The model could not build questions from this material." }, 502);

    const payload = {
      ok: true,
      questions: withIds(questions),
      partial: questions.length < count ? { want: count, got: questions.length } : null,
      ai: { provider: status.provider, label: status.label, model: status.model },
    };
    cacheSet(key, payload);
    return json(payload);
  } catch (err) {
    return json({ ok: false, reason: err?.reason || "ai-error", error: String(err?.message || err).slice(0, 400) }, err?.status || 502, {
      "x-qraya-fallback": "1",
    });
  }
});

/** Narrow the course to the requested chapter / concept before spending tokens. */
function applyScope(course, scope) {
  const chapters = course.chapters.map(ch => ({
    title: ch.title,
    summary: ch.summary || "",
    concepts: Array.isArray(ch.concepts) ? ch.concepts : [],
    formulas: Array.isArray(ch.formulas) ? ch.formulas : [],
  }));

  if (scope?.kind === "chapter" && scope.id) {
    const hit = chapters.filter(ch => ch.title === scope.id);
    if (hit.length) return { ...course, chapters: hit };
  }
  if (scope?.kind === "topic" && scope.id) {
    const wanted = String(scope.id).toLowerCase();
    const hit = chapters
      .map(ch => ({ ...ch, concepts: ch.concepts.filter(c => String(c.term).toLowerCase() === wanted) }))
      .filter(ch => ch.concepts.length);
    if (hit.length) return { ...course, chapters: hit };
  }

  // Whole course: cap the material sent to the model so a huge PDF cannot blow
  // the request up. Every chapter keeps at least its first concepts.
  const MAX_CONCEPTS = Number(process.env.MAX_CONCEPTS_PER_REQUEST || 90);
  let total = chapters.reduce((n, ch) => n + ch.concepts.length, 0);
  if (total <= MAX_CONCEPTS) return { ...course, chapters };

  const perChapter = Math.max(2, Math.floor(MAX_CONCEPTS / chapters.length));
  return {
    ...course,
    chapters: chapters.map(ch => ({ ...ch, concepts: ch.concepts.slice(0, perChapter) })),
  };
}

function fingerprint(course) {
  const terms = course.chapters.flatMap(ch => ch.concepts.map(c => c.term)).join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < terms.length; i++) {
    h ^= terms.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function systemPrompt() {
  return `You write exam-style quiz questions from a student's own course material for
Qraya, a revision app used by Tunisian Bac and Prépa students.

Absolute rules:
- Every question, option and explanation comes from the COURSE JSON provided.
  Never import outside knowledge, never invent a fact, number or formula.
- Write questions, options and explanations in the requested language only.
- Preserve mathematical notation, symbols and units exactly as in the course.
- Exactly one correct option per mcq. Distractors must be plausible confusions.
- Never repeat a question you already asked in this quiz.
- Never ask about the document itself (its title, layout, page numbers).
- Output ONLY the JSON object: no markdown fences, no commentary.`;
}
