#!/usr/bin/env node
/* Qraya backend test suite — no test framework, no network, no API key.
 *
 * It starts a fake OpenAI-compatible provider that deliberately misbehaves the
 * way real free tiers do (429 on the first call, a provider that rejects
 * json_schema, malformed JSON with fences and trailing commas) and asserts that
 * the real request path survives all of it.
 *
 *   node test/api.test.mjs
 */
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS  " : "FAIL  "}${name}${cond ? "" : "  << " + (extra ?? "")}`);
};
const section = t => console.log(`\n── ${t} ──`);

/* ═══════════════════════════════ fake provider ══════════════════════════ */
const calls = { total: 0, modes: [], retried429: false, downgradedSchema: false, repairedJson: false, models: 0 };

function courseForChunk(index) {
  return {
    title: "Algorithmique",
    subject: "Informatique",
    lang: "fr",
    difficulty: "intermediate",
    keywords: ["complexité", "récursivité", "tri", "dichotomie"],
    chapters: [
      {
        title: index === 0 ? "Introduction et complexité" : "Tris et recherche",
        summary: "Ce qu'est un algorithme et comment mesurer son coût.",
        concepts: [
          { term: "Algorithme", def: "Suite finie et ordonnée d'instructions qui transforme des données d'entrée en un résultat." },
          { term: "Complexité temporelle", def: "Nombre d'opérations élémentaires exécutées en fonction de la taille n des données." },
          { term: "Recherche dichotomique", def: "Recherche qui coupe l'intervalle en deux à chaque comparaison." },
        ],
        formulas: ["T(n) = O(n log n)"],
        examples: ["Comparer un tri en O(n²) avec un tri en O(n log n)."],
      },
    ],
  };
}

let questionNo = 0;
function quizFor(count) {
  const questions = [];
  // Later batches deliberately open with a repeat, the way real models do when
  // they lose track of what they already asked.
  if (questionNo > 0) {
    questions.push({
      type: "mcq",
      prompt: `Question 1 : que signifie « Algorithme 1 » ?`,
      options: [
        { text: "Bonne réponse", correct: true },
        { text: "Distracteur plausible", correct: false },
        { text: "Autre distracteur", correct: false },
        { text: "Encore un", correct: false },
      ],
      explanation: "Une phrase courte qui explique pourquoi.",
      sourceRef: "Introduction et complexité",
      difficulty: "easy",
    });
  }
  for (let i = 0; i < count; i++) {
    questionNo++;
    const n = questionNo;
    questions.push({
      type: n % 5 === 0 ? "short" : "mcq",
      prompt: n % 5 === 0 ? `Définissez brièvement la notion numéro ${n}.` : `Question ${n} : que signifie « Algorithme ${n} » ?`,
      options: [
        { text: `Bonne réponse ${n}`, correct: true },
        { text: "Distracteur plausible", correct: false },
        { text: "Autre distracteur", correct: false },
        { text: "Encore un", correct: false },
      ],
      answerText: "Algorithme",
      explanation: "Une phrase courte qui explique pourquoi.",
      sourceRef: "Introduction et complexité",
      difficulty: n % 3 === 0 ? "easy" : "medium",
    });
  }
  return { questions };
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";
  const send = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (url.endsWith("/models")) {
    calls.models++;
    return send(200, {
      data: [{ id: "gemini-2.5-flash" }, { id: "gemini-3.8-flash" }, { id: "text-embedding-004" }, { id: "gemini-2.5-flash-image" }],
    });
  }

  if (url.endsWith("/chat/completions")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    calls.total++;
    const mode = body.response_format?.type || "none";
    calls.modes.push(mode);

    // 1) free-tier style rate limit on the very first call
    if (calls.total === 1 && !calls.retried429) {
      calls.retried429 = true;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      return res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
    }
    // 2) a provider that refuses structured output
    if (mode === "json_schema" && !calls.downgradedSchema) {
      calls.downgradedSchema = true;
      return send(400, { error: { message: "response_format json_schema is not supported by this endpoint" } });
    }

    const system = body.messages?.[0]?.content || "";
    const user = body.messages?.[1]?.content || "";
    let payload;
    if (system.includes("extract the study structure")) {
      payload = courseForChunk(calls.total % 2);
    } else if (system.includes("quiz questions")) {
      const m = user.match(/exactly (\d+) questions/i);
      payload = quizFor(Math.min(Number(m?.[1] || 5), 12));
    } else {
      const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
      payload = { results: ids.map(id => ({ id, correct: true, explanation: "Le fond de la réponse est correct.", missing: [] })) };
    }

    // 3) once, return sloppy JSON that needs the repair pass
    if (!calls.repairedJson && calls.total > 3) {
      calls.repairedJson = true;
      const sloppy = "```json\n" + JSON.stringify(payload).replace("Bonne réponse", "Bonne réponse") + ",\n```";
      return send(200, { choices: [{ message: { content: sloppy } }], usage: { total_tokens: 42 } });
    }
    return send(200, { choices: [{ message: { content: JSON.stringify(payload) } }], usage: { total_tokens: 99 } });
  }

  send(404, { error: "not found" });
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const providerPort = server.address().port;

/* ═════════════════════════════ server under test ═══════════════════════ */
process.env.LLM_PROVIDER = "custom";
process.env.LLM_BASE_URL = `http://127.0.0.1:${providerPort}`;
process.env.LLM_API_KEY = "test-key";
process.env.LLM_LABEL = "Fake Provider";
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

const health = (await import("../api/health.js")).default;
const analyse = (await import("../api/analyse.js")).default;
const quiz = (await import("../api/quiz.js")).default;
const grade = (await import("../api/grade.js")).default;

const req = (pathname, body, method = "POST") =>
  new Request(`http://localhost${pathname}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "41.0.0.1" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
const j = async r => ({ status: r.status, body: await r.json() });

/* ══════════════════════════════════ tests ═══════════════════════════════ */
section("health & provider detection");
{
  const { status, body } = await j(await health(req("/api/health", null, "GET")));
  ok("health responds 200", status === 200, status);
  ok("reports AI enabled with a key", body.ai === true, JSON.stringify(body));
  ok("lists configured providers", Array.isArray(body.available) && body.available.some(p => p.configured), JSON.stringify(body.available));
  ok("never echoes a key", !JSON.stringify(body).includes("test-key"), JSON.stringify(body).slice(0, 120));
}

section("course analysis (retry, schema downgrade, discovery)");
let course;
{
  const { status, body } = await j(await analyse(req("/api/analyse", { text: "Le principe d'inertie. " .repeat(40), meta: { fileName: "cours.pdf", pages: 12 } })));
  ok("analyse responds 200", status === 200, JSON.stringify(body).slice(0, 200));
  ok("survived the 429 and retried", calls.retried429 && calls.total > 1, `calls=${calls.total}`);
  ok("downgraded away from json_schema", calls.downgradedSchema, calls.modes.join(","));
  course = body.course; // the first successful call is what resolves the model
  ok("returns a normalised course", !!course && course.id && course.title === "Algorithmique", JSON.stringify(course)?.slice(0, 160));
  ok("course carries the app's _stats", course?._stats?.concepts >= 3, JSON.stringify(course?._stats));
  ok("marks the source as AI", course?.ai === "llm", course?.ai);
  ok("pages kept from client metadata", course?.pages === 12, course?.pages);
  ok("concepts tagged for the UI", course?.chapters?.[0]?.concepts?.[0]?.via === "llm", JSON.stringify(course?.chapters?.[0]?.concepts?.[0]));
}

section("long document chunking + merge");
{
  const long = ("Un paragraphe de cours suffisamment long pour dépasser la limite. ".repeat(20) + "\n\n").repeat(30);
  const before = calls.total;
  const { status, body } = await j(await analyse(req("/api/analyse", { text: long, meta: { pages: 80 } })));
  ok("long document analysed", status === 200, JSON.stringify(body).slice(0, 160));
  ok("was split into several model calls", body.parts > 1, `parts=${body.parts}`);
  ok("chapters merged and deduped", body.course?.chapters?.length >= 1 && body.course.chapters.every(ch => new Set(ch.concepts.map(c => c.term)).size === ch.concepts.length), JSON.stringify(body.course?.chapters?.map(c => c.title)));
  ok("keywords merged", body.course?.keywords?.length > 0, JSON.stringify(body.course?.keywords));
  ok("no infinite batching", calls.total - before < 20, `calls=${calls.total - before}`);
}

section("quiz generation");
{
  const { body: h } = await j(await health(req("/api/health", null, "GET")));
  ok("discovered a usable model", /gemini/i.test(h.model || ""), JSON.stringify(h));

  const { status, body } = await j(await quiz(req("/api/quiz", { course, config: { count: 10, difficulty: "mixed", type: "mixed", scope: { kind: "whole" } }, lang: "fr" })));
  ok("quiz responds 200", status === 200, JSON.stringify(body).slice(0, 200));
  ok("returns exactly the requested count", body.questions?.length === 10, `got ${body.questions?.length}`);
  ok("worked around batches that repeat themselves", calls.total > 3, `calls=${calls.total}`);
  ok("every question has an id and a number", body.questions.every((q, i) => q.id && q.n === i + 1), JSON.stringify(body.questions?.[0]));
  ok("mcq has exactly one correct option", body.questions.filter(q => q.type === "mcq").every(q => q.options.filter(o => o.correct).length === 1), "ambiguous mcq");
  ok("every question explains itself", body.questions.every(q => typeof q.explanation === "string" && q.explanation.length > 3));
  ok("sourceRef points at a real chapter", body.questions.every(q => course.chapters.some(c => c.title === q.sourceRef)), JSON.stringify(body.questions?.map(q => q.sourceRef)));
  ok("no duplicate prompts", new Set(body.questions.map(q => q.prompt)).size === body.questions.length);
  ok("short answers carry an expected answer", body.questions.filter(q => q.type === "short").every(q => q.answerText?.length > 0), "short without answerText");

  const chapterScoped = await j(await quiz(req("/api/quiz", { course, config: { count: 5, difficulty: "easy", type: "mcq", scope: { kind: "chapter", id: "Tris et recherche" } }, lang: "fr" })));
  ok("chapter scope accepted", chapterScoped.status === 200, JSON.stringify(chapterScoped.body).slice(0, 160));

  const bad = await j(await quiz(req("/api/quiz", { course: null })));
  ok("rejects a missing course", bad.status === 400, bad.status);

  const huge = await j(await quiz(req("/api/quiz", { course, config: { count: 500 } })));
  ok("caps the question count", huge.body.questions?.length <= 30, `got ${huge.body.questions?.length}`);
}

section("short-answer grading");
{
  const items = [
    { id: "q_1", prompt: "Quel terme complète : ______ coupe l'intervalle en deux ?", expected: "Recherche dichotomique", answer: "la recherche dichotomique" },
    { id: "q_2", prompt: "Définir la complexité spatiale.", expected: "mémoire supplémentaire utilisée", answer: "je ne sais pas" },
  ];
  const { status, body } = await j(await grade(req("/api/grade", { lang: "fr", items })));
  ok("grade responds 200", status === 200, JSON.stringify(body).slice(0, 200));
  ok("reconciles every id it was given", body.results?.length === items.length && body.results.every((r, i) => r.id === items[i].id), JSON.stringify(body.results));
  ok("returns an explanation per answer", body.results.every(r => r.explanation.length > 3));
  const empty = await j(await grade(req("/api/grade", { items: [] })));
  ok("rejects an empty batch", empty.status === 400, empty.status);
}

section("input validation & limits");
{
  const short = await j(await analyse(req("/api/analyse", { text: "trop court" })));
  ok("rejects text that is too short", short.status === 422, short.status);

  const big = await j(await analyse(req("/api/analyse", { text: "x".repeat(200000) })));
  ok("rejects text over the size limit", big.status === 413, big.status);

  const wrongMethod = await j(await analyse(req("/api/analyse", {}, "GET")));
  ok("rejects GET on analyse", wrongMethod.status === 405, wrongMethod.status);

  const { body } = await j(await health(req("/api/health", null, "GET")));
  ok("exposes configured limits", body.limits?.maxQuestions === 30, JSON.stringify(body.limits));
}

section("key-free mode (must degrade, never break)");
{
  const saved = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, provider: process.env.LLM_PROVIDER };
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_PROVIDER;

  const { body } = await j(await health(req("/api/health", null, "GET")));
  ok("health says AI is off", body.ai === false, JSON.stringify(body.ai));

  const a = await j(await analyse(req("/api/analyse", { text: "du texte valide mais suffisamment long pour passer la validation initiale du serveur, encore un peu".repeat(3) })));
  ok("analyse answers 503 no-provider", a.status === 503 && a.body.reason === "no-provider", JSON.stringify(a.body));

  const q = await j(await quiz(req("/api/quiz", { course })));
  ok("quiz answers 503 no-provider", q.status === 503 && q.body.reason === "no-provider", JSON.stringify(q.body));

  const g = await j(await grade(req("/api/grade", { items: [{ id: "a", expected: "b" }] })));
  ok("grade answers 503 no-provider", g.status === 503, JSON.stringify(g.body));

  Object.assign(process.env, { LLM_BASE_URL: saved.base, LLM_API_KEY: saved.key, LLM_PROVIDER: saved.provider });
}

section("end-to-end through the local server");
{
  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(root, "dev-server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) { up = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  ok("dev server boots", up, `port ${port}`);

  if (up) {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    ok("serves the website at /", page.status === 200 && html.includes("Qraya"), `${page.status} ${html.length}b`);
    ok("app ships its offline fallback engine", html.includes("Engine") && html.includes("Qraya"), "engine missing");

    const h = await (await fetch(`${base}/api/health`)).json();
    ok("health over HTTP", h.ok === true && h.ai === true, JSON.stringify(h).slice(0, 120));

    const quizRes = await fetch(`${base}/api/quiz`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ course, config: { count: 5, difficulty: "mixed", type: "mcq", scope: { kind: "whole" } }, lang: "fr" }),
    });
    const quizBody = await quizRes.json();
    ok("quiz works over HTTP", quizRes.status === 200 && quizBody.questions?.length === 5, `${quizRes.status} n=${quizBody.questions?.length}`);

    const unknown = await fetch(`${base}/api/nope`);
    ok("unknown endpoint 404s", unknown.status === 404, unknown.status);

    const asset = await fetch(`${base}/index.html`);
    ok("index.html served with correct type", (asset.headers.get("content-type") || "").includes("text/html"), asset.headers.get("content-type"));
  }

  child.kill();
  await once(child, "exit").catch(() => {});
}

/* ═════════════════════════════════ summary ═════════════════════════════ */
server.close();
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
console.log(`  model calls made: ${calls.total}, schema modes tried: ${[...new Set(calls.modes)].join(" -> ")}, /models lookups: ${calls.models}`);
process.exit(fail ? 1 : 0);
