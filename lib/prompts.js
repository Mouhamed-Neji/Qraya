/* Server-side prompts and schemas.
 *
 * These live on the server on purpose (spec §21): the client never sees the
 * prompts, and can never be made to talk to a model directly.
 *
 * The shapes below must match what public/index.html consumes — the UI was built
 * against the deterministic engine, so normaliseCourse() is the only adapter
 * needed for real AI output to drop straight in.
 */

/* ---------------------------------------------------------------- schemas */
export const COURSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "subject", "lang", "difficulty", "chapters", "keywords"],
  properties: {
    title: { type: "string" },
    subject: { type: "string" },
    lang: { type: "string", enum: ["fr", "ar", "en"] },
    difficulty: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
    chapters: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "concepts", "formulas", "examples"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          concepts: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["term", "def"],
              properties: { term: { type: "string" }, def: { type: "string" } },
            },
          },
          formulas: { type: "array", items: { type: "string" } },
          examples: { type: "array", items: { type: "string" } },
        },
      },
    },
    keywords: { type: "array", items: { type: "string" } },
  },
};

export const QUIZ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "prompt", "explanation", "sourceRef", "difficulty"],
        properties: {
          type: { type: "string", enum: ["mcq", "tf", "short"] },
          prompt: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "correct"],
              properties: { text: { type: "string" }, correct: { type: "boolean" } },
            },
          },
          answerText: { type: "string" },
          explanation: { type: "string" },
          sourceRef: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
        },
      },
    },
  },
};

export const GRADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "correct", "explanation"],
        properties: {
          id: { type: "string" },
          correct: { type: "boolean" },
          explanation: { type: "string" },
          missing: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/* ---------------------------------------------------------------- prompts */
const AI_RULES = `You are the study engine inside Qraya, a revision app used by Tunisian
Bac and Prépa students. You are a study assistant, never a chatbot.

Absolute rules:
- Use ONLY the material provided. Never add outside facts, never invent a formula,
  a date, a number or a definition that is not supported by the text.
- Preserve the LANGUAGE of the source material exactly (French stays French,
  Arabic stays Arabic, English stays English). In a mixed course keep the original
  technical terms rather than translating them.
- Preserve mathematical notation, symbols and units as written.
- If the text is too thin or ambiguous for a requested item, produce fewer items
  instead of filling the gap with guesses.
- Never output markdown fences, headings or commentary: only the JSON object.`;

export function analysePrompt(text, meta = {}, partInfo = null) {
  const head = partInfo
    ? `This is part ${partInfo.index} of ${partInfo.total} of ONE course document. Extract only what appears in this part.`
    : `Extract the structure of this course document.`;
  return `${head}

Hints: filename="${meta.fileName || "unknown"}", ${meta.pages || "?"} pages.

Produce JSON with:
- title: the real course title taken from the document (not the filename) when visible.
- subject: a short school subject label, e.g. "Informatique", "Mathématiques", "Physique", "علوم تجريبية".
- lang: "fr", "ar" or "en" — the dominant language of the material.
- difficulty: "beginner", "intermediate" or "advanced", judged from concept density and formulas.
- chapters: the document's real sections in order. For each: a short title, one
  sentence summary, the concepts it actually defines (term + definition in the
  document's language, definition 1-3 sentences), the formulas literally present,
  and its worked examples as short one-line summaries.
- keywords: 8-14 key terms of the course, in the course language.

DOCUMENT:
"""
${text}
"""`;
}

export function quizPrompt(course, config, lang, { focus = [], avoid = [] } = {}) {
  const allowedTypes =
    config.type === "mixed" ? "mcq, tf or short" : config.type === "mcq" ? "only mcq" : config.type === "tf" ? "only tf" : "only short";
  const n = config.count || 10;
  const difficulty =
    config.difficulty === "mixed"
      ? "mix easy, medium and hard questions"
      : `keep every question at "${config.difficulty}" level`;

  const scopeLine =
    config.scope?.kind === "chapter" && config.scope.id
      ? `Scope: ONLY the chapter "${config.scope.id}".`
      : config.scope?.kind === "topic" && config.scope.id
        ? `Scope: ONLY the concept "${config.scope.id}".`
        : "Scope: the whole course.";

  const weakLine = focus.length
    ? `\nThe student previously failed these concepts — prioritise them, then cover the rest:\n- ${focus.slice(0, 20).join("\n- ")}`
    : "";
  const avoidLine = avoid.length
    ? `\nDo NOT repeat or paraphrase these questions, they were already asked in this quiz:\n- ${avoid.slice(-14).map(s => oneLine(s, 120)).join("\n- ")}`
    : "";

  return `Write exactly ${n} questions for this quiz.

${scopeLine}
Question types: ${allowedTypes}.
Difficulty: ${difficulty}.${weakLine}
Question language: ${lang} — the same language as the course material. Write the
questions, the answer options and the explanations in ${lang}.${avoidLine}

Rules for the questions:
- Build every question from the COURSE given below. Nothing outside it.
- Prefer the important concepts over trivia; never ask about wording, page numbers or file details.
- Never repeat the same idea twice; each question must test a different concept.
- mcq: exactly 4 options with exactly ONE correct option. Distractors must be
  plausible confusions a real student would make (a similar concept, an inverted
  relation, an off-by-one formula), never obviously absurd.
- tf: statement + the two options "true"/"false" written in ${lang}, with the
  correct flag set. A false statement must be false for a specific, explainable reason.
- short: give "answerText" — the expected answer, as short as possible (a term, a
  formula, a value) — and no "options".
- explanation: ONE or TWO short sentences in ${lang} saying why the correct answer
  is correct. Never a long paragraph.
- sourceRef: the exact chapter title from the course this question comes from.
- difficulty: "easy" (recall a definition), "medium" (apply or distinguish),
  "hard" (link concepts, reason about a case).

COURSE (JSON):
${JSON.stringify({ title: course.title, lang: course.lang, chapters: course.chapters })}

Answer with {"questions":[...]} only.`;
}

export function gradePrompt(items, lang) {
  return `You are correcting short-answer questions from a student's quiz.
Accept an answer as correct when the MEANING is right, even if the wording differs,
it is shorter, or the student uses a synonym in ${lang} or the other language of the
course (French/Arabic/English are interchangeable for judging meaning).
Reject it when a required key element is missing or the answer is off-topic.
Never invent requirements that are not in the expected answer.

For each item return:
- id: the given id, unchanged
- correct: true or false
- explanation: ONE short sentence in ${lang}. If wrong, say precisely what was
  missing or wrong; if right, confirm the key point.
- missing: the key elements the student did not mention ([] when correct)

ITEMS (JSON):
${JSON.stringify(items)}
`;
}

/* --------------------------------------------------------------- chunking */
/** Split a long document on paragraph boundaries (with a small overlap). */
export function chunkText(text, maxChars = Number(process.env.MAX_CHUNK_CHARS || 9000)) {
  const clean = String(text || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (clean.length <= maxChars) return [clean];

  const paras = clean.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paras) {
    if (para.length > maxChars) {
      // A single huge block: cut it on sentence boundaries.
      push();
      const sentences = para.split(/(?<=[.!?؟])\s+/);
      let s = "";
      for (const sentence of sentences) {
        if ((s + sentence).length > maxChars) {
          if (s.trim()) chunks.push(s.trim());
          s = sentence;
          while (s.length > maxChars) {
            chunks.push(s.slice(0, maxChars));
            s = s.slice(maxChars);
          }
        } else s += (s ? " " : "") + sentence;
      }
      if (s.trim()) chunks.push(s.trim());
      continue;
    }
    if ((current + "\n\n" + para).length > maxChars) {
      push();
      // keep one paragraph of overlap so a definition split across the seam survives
      current = chunks.length ? chunks[chunks.length - 1].split(/\n{2,}/).pop().slice(-600) + "\n\n" : "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  push();
  return chunks.filter(Boolean);
}

/* ---------------------------------------------------------------- merging */
const normKey = s =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const list = v => (Array.isArray(v) ? v : []);
const str = v => (typeof v === "string" ? v : v == null ? "" : String(v));
const oneLine = (s, max) => str(s).replace(/\s+/g, " ").trim().slice(0, max);

/** Merge one or more raw model outputs into a single course object. */
export function mergeAnalyses(parts, meta = {}) {
  const chapters = [];
  const byChapter = new Map();
  const seenConcepts = new Set();
  const keywords = new Set();
  const langVotes = {};
  const diffVotes = {};

  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.lang) langVotes[raw.lang] = (langVotes[raw.lang] || 0) + 1;
    if (raw.difficulty) diffVotes[raw.difficulty] = (diffVotes[raw.difficulty] || 0) + 1;
    list(raw.keywords).forEach(k => k && keywords.add(oneLine(k, 40)));

    for (const ch of list(raw.chapters)) {
      const title = oneLine(ch?.title, 110) || "Chapitre";
      const key = normKey(title);
      let target = byChapter.get(key);
      if (!target) {
        target = { title, summary: oneLine(ch?.summary, 200), concepts: [], formulas: [], examples: [] };
        byChapter.set(key, target);
        chapters.push(target);
      }
      if (!target.summary && ch?.summary) target.summary = oneLine(ch.summary, 200);

      for (const c of list(ch?.concepts)) {
        const term = oneLine(c?.term, 70).replace(/^(?:le|la|les|un|une|des|the|a|an)\s+/i, "");
        const def = oneLine(c?.def, 400);
        if (term.length < 2 || def.length < 12) continue;
        const ck = normKey(term);
        if (seenConcepts.has(ck)) continue;
        seenConcepts.add(ck);
        target.concepts.push({ term, def });
      }
      list(ch?.formulas).forEach(f => {
        const v = oneLine(f, 140);
        if (v && !target.formulas.includes(v)) target.formulas.push(v);
      });
      list(ch?.examples).forEach(e => {
        const v = oneLine(e, 200);
        if (v && !target.examples.includes(v) && target.examples.length < 3) target.examples.push(v);
      });
    }
  }

  const kept = chapters.filter(c => c.concepts.length);
  const primary = parts.find(p => p && typeof p === "object") || {};
  const metrics = {
    concepts: kept.reduce((n, c) => n + c.concepts.length, 0),
    formulas: kept.reduce((n, c) => n + c.formulas.length, 0),
    chapters: kept.length,
  };

  const lang = top(langVotes) || meta.lang || "fr";
  return {
    title: oneLine(primary.title, 90) || oneLine(meta.title, 90) || (lang === "ar" ? "درس" : "Cours"),
    subject: oneLine(primary.subject, 40) || meta.subject || "Autre",
    lang,
    difficulty: top(diffVotes) || (metrics.concepts > 26 && metrics.formulas > 6 ? "advanced" : metrics.concepts < 8 ? "beginner" : "intermediate"),
    chapters: kept,
    keywords: Array.from(keywords).slice(0, 16),
    _metrics: metrics,
  };
}

function top(votes) {
  const e = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  return e.length ? e[0][0] : null;
}

/* --------------------------------------------------------- normalisation */
/** Coerce model output into the exact course object the UI expects. */
export function normaliseCourse(merged, meta = {}, ai = {}) {
  const lang = ["fr", "ar", "en"].includes(merged.lang) ? merged.lang : "fr";
  const metrics = merged._metrics || { concepts: 0, chapters: 0, formulas: 0 };
  const chapters = (merged.chapters || []).map(ch => ({
    title: ch.title,
    summary: ch.summary || "",
    concepts: ch.concepts.map(c => ({ term: c.term, def: c.def, via: "llm" })),
    formulas: ch.formulas || [],
    examples: ch.examples || [],
  }));
  const pages = meta.pages && meta.pages > 0 ? meta.pages : Math.max(1, Math.round((meta.charCount || 0) / 2100));

  return {
    id: uid("c"),
    createdAt: Date.now(),
    title: merged.title,
    subject: merged.subject,
    lang,
    pages,
    difficulty: merged.difficulty,
    author: meta.author || (meta.fileName || "Document importé"),
    size: meta.size || 0,
    fileName: meta.fileName || null,
    lowConfidence: !!meta.lowConfidence,
    chapters,
    keywords: merged.keywords || [],
    ai: "llm",
    _stats: { concepts: metrics.concepts, formulas: metrics.formulas, chapters: metrics.chapters || chapters.length, structured: metrics.concepts },
  };
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

/* ------------------------------------------------------------ quiz repair */
/** Make model questions safe for the client: ids, one correct option, ordering. */
export function normaliseQuestions(raw, { count, chapters = [], type = "mixed" } = {}) {
  const validTitles = new Set(chapters.map(c => c.title));
  const fallbackRef = chapters[0]?.title || "";
  const seen = new Set();
  const out = [];

  for (const q of list(raw)) {
    let kind = ["mcq", "tf", "short"].includes(q?.type) ? q.type : "mcq";
    if (type !== "mixed") kind = type;

    const prompt = oneLine(q?.prompt, 1200);
    if (prompt.length < 8) continue;
    const dedupeKey = normKey(prompt);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const explanation = oneLine(q?.explanation, 600) || "";
    const sourceRef = validTitles.has(oneLine(q?.sourceRef, 110)) ? oneLine(q.sourceRef, 110) : fallbackRef;
    const difficulty = ["easy", "medium", "hard"].includes(q?.difficulty) ? q.difficulty : "medium";

    if (kind === "mcq" || kind === "tf") {
      let options = list(q?.options)
        .map(o => ({ text: oneLine(o?.text, 400), correct: !!o?.correct }))
        .filter(o => o.text.length > 0);

      if (kind === "tf") {
        // rebuild true/false options so labels + flags can never disagree
        const answerTrue = options.find(o => o.correct)?.text;
        const isTrue = !/^(?:false|faux|خاطئ|خطأ|غير صحيح)$/i.test(str(answerTrue).trim());
        options = [{ text: "true", correct: isTrue }, { text: "false", correct: !isTrue }];
      } else {
        const correct = options.filter(o => o.correct);
        if (correct.length !== 1) continue; // ambiguous or broken: drop it
        options = options.slice(0, 6);
        if (options.length < 3) continue;
      }
      out.push({ type: kind, prompt, options, explanation, sourceRef, difficulty });
    } else {
      const answerText = oneLine(q?.answerText, 300);
      if (!answerText) continue;
      out.push({ type: "short", prompt, answerText, explanation, sourceRef, difficulty });
    }
    if (out.length >= count) break;
  }
  return out;
}

export function withIds(questions) {
  return questions.map((q, i) => ({ ...q, id: uid("q"), n: i + 1 }));
}
