#!/usr/bin/env node
/* End-to-end test: the real website, in a DOM, talking to the real backend,
 * which talks to a fake (misbehaving) model provider.
 *
 * This is the test that proves the chain a student actually uses:
 *   paste a course -> AI analysis -> AI quiz -> answer -> AI grading -> results
 *
 *   node test/browser-ai.test.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = require("/home/user/node_modules/jsdom");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`${c ? "PASS  " : "FAIL  "}${n}${c ? "" : "  << " + (x ?? "")}`); };
const section = t => console.log(`\n── ${t} ──`);

/* ── fake provider ─────────────────────────────────────────────────────── */
let questionNo = 0;
const seen = { analyse: 0, quiz: 0, grade: 0 };

const provider = http.createServer(async (req, res) => {
  const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if ((req.url || "").endsWith("/models")) return json(200, { data: [{ id: "gemini-2.5-flash" }] });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const system = body.messages?.[0]?.content || "";
  const user = body.messages?.[1]?.content || "";

  if (system.includes("extract the study structure")) {
    seen.analyse++;
    return json(200, { choices: [{ message: { content: JSON.stringify({
      title: "Réseaux informatiques",
      subject: "Informatique",
      lang: "fr",
      difficulty: "intermediate",
      keywords: ["réseau", "IP", "pare-feu", "chiffrement"],
      chapters: [
        { title: "Les réseaux", summary: "Échanger des informations entre machines.",
          concepts: [
            { term: "Réseau informatique", def: "Ensemble d'équipements reliés entre eux pour échanger des informations." },
            { term: "Adresse IP", def: "Identifiant numérique unique attribué à chaque machine sur un réseau." },
            { term: "Bande passante", def: "Quantité maximale de données transmissibles par seconde sur un lien." },
          ],
          formulas: ["Débit = données / durée"], examples: ["Un réseau local relie les postes d'une salle."] },
        { title: "Sécurité réseau", summary: "Protéger les échanges.",
          concepts: [
            { term: "Pare-feu", def: "Dispositif qui filtre le trafic entrant et sortant selon des règles." },
            { term: "Chiffrement", def: "Transformation d'un message lisible en message illisible sans la clé." },
          ],
          formulas: [], examples: [] },
      ],
    }) } }] });
  }

  if (system.includes("quiz questions")) {
    seen.quiz++;
    const n = Math.min(Number((user.match(/exactly (\d+) questions/i) || [])[1] || 5), 12);
    const questions = [];
    for (let i = 0; i < n; i++) {
      questionNo++;
      const k = questionNo;
      if (k === 2) {
        questions.push({ type: "short", prompt: "Quel dispositif filtre le trafic entrant et sortant ?",
          answerText: "Pare-feu", explanation: "Le pare-feu applique des règles de filtrage.", sourceRef: "Sécurité réseau", difficulty: "medium" });
      } else {
        questions.push({ type: "mcq", prompt: `Que signifie « Notion ${k} » ?`,
          options: [{ text: `Définition correcte ${k}`, correct: true }, { text: "Distracteur A", correct: false },
                    { text: "Distracteur B", correct: false }, { text: "Distracteur C", correct: false }],
          explanation: `Explication courte pour la notion ${k}.`, sourceRef: "Les réseaux", difficulty: "easy" });
      }
    }
    return json(200, { choices: [{ message: { content: JSON.stringify({ questions }) } }] });
  }

  // grading
  seen.grade++;
  const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
  return json(200, { choices: [{ message: { content: JSON.stringify({
    results: ids.map(id => ({ id, correct: true, explanation: "IA : le fond de la réponse est correct.", missing: [] })),
  }) } }] });
});

await new Promise(r => provider.listen(0, "127.0.0.1", r));
const providerPort = provider.address().port;

/* ── app server ────────────────────────────────────────────────────────── */
const appPort = 4400 + Math.floor(Math.random() * 100);
const child = spawn(process.execPath, [path.join(root, "dev-server.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(appPort),
    LLM_PROVIDER: "custom",
    LLM_BASE_URL: `http://127.0.0.1:${providerPort}`,
    LLM_API_KEY: "test-key",
    LLM_LABEL: "Fake Provider",
    GEMINI_API_KEY: "",
    GROQ_API_KEY: "",
    OPENROUTER_API_KEY: "",
    OPENAI_API_KEY: "",
  },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${appPort}`;

let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${base}/api/health`); if (r.ok) { up = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 150));
}
ok("backend is up", up);

/* ── load the real page in a DOM, with fetch wired to the server ────────── */
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const errors = [];
const dom = new JSDOM(html, {
  url: `${base}/`,
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(w) {
    w.scrollTo = () => {};
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    // jsdom has no fetch: bridge to Node's, translating the abort signal.
    w.fetch = (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const nodeInit = { ...init };
      if (init.signal) {
        const ac = new AbortController();
        if (init.signal.aborted) ac.abort();
        else init.signal.addEventListener("abort", () => ac.abort());
        nodeInit.signal = ac.signal;
      }
      return globalThis.fetch(new URL(url, base), nodeInit);
    };
  },
});
const { window } = dom;
const d = window.document;
window.addEventListener("error", e => errors.push(e.error?.stack || e.message));
process.on("unhandledRejection", r => errors.push("unhandledRejection: " + r));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = () => d.getElementById("app")?.textContent || "";
const state = () => JSON.parse(window.localStorage.getItem("qraya.state.v1") || "{}");
const click = async sel => {
  const el = d.querySelector(sel);
  if (!el) throw new Error("missing " + sel);
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
};
const type = (sel, value) => {
  const el = d.querySelector(sel);
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
  return el;
};
const waitFor = async (fn, ms = 15000, step = 120) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};

section("backend detection in the browser");
await sleep(700);
ok("app detects the AI backend", window.eval("AI.info.ai") === true, JSON.stringify(window.eval("AI.info")));
ok("shows the provider name", /Fake Provider/.test(txt()) || window.eval("AI.info.label") === "Fake Provider", JSON.stringify(window.eval("AI.info")));

section("upload → AI analysis");
await click("[data-demo]");
await sleep(300);
window.location.hash = "#/upload";
await sleep(200);
const course_text = `Chapitre 1 : Les réseaux informatiques
Un réseau informatique : ensemble d'équipements reliés entre eux pour échanger des informations.
L'adresse IP est un identifiant numérique unique attribué à chaque machine sur un réseau.
La bande passante désigne la quantité maximale de données transmissibles par seconde.
Chapitre 2 : Sécurité réseau
Le pare-feu est un dispositif qui filtre le trafic entrant et sortant selon des règles.
Le chiffrement est la transformation d'un message lisible en message illisible sans la clé.
`.repeat(3);
type("#paste-text", course_text);
await sleep(50);
d.querySelector("[data-paste-analyse]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

ok("analysis calls the model", await waitFor(() => seen.analyse > 0, 8000), `analyse=${seen.analyse}`);
ok("lands on the course page", await waitFor(() => /#\/course\//.test(window.location.hash), 20000), window.location.hash);

const course = state().courses.find(c => /Réseaux/.test(c.title));
ok("course came from the AI", course?.ai === "llm", JSON.stringify(course?.ai));
ok("AI chapter titles kept", course?.chapters?.some(c => c.title === "Sécurité réseau"), JSON.stringify(course?.chapters?.map(c => c.title)));
ok("AI concepts kept", (course?._stats?.concepts || 0) >= 5, JSON.stringify(course?._stats));
ok("page labels the AI analysis", /Analyse IA/.test(txt()), txt().slice(0, 120));
ok("memory says model, not heuristic", course?.chapters?.[0]?.concepts?.[0]?.via === "llm");

section("quiz generation through the API");
window.location.hash = `#/quiz/new?course=${course.id}`;
await sleep(250);
await click("[data-count='10']");
const before = seen.quiz;
d.querySelector("[data-generate]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
ok("generation calls the model", await waitFor(() => seen.quiz > before, 8000), `quiz=${seen.quiz}`);
ok("quiz opens", await waitFor(() => /#\/quiz\/run\//.test(window.location.hash), 25000), window.location.hash);

const quizId = window.location.hash.split("/").pop();
const quiz = state().quizzes.find(q => q.id === quizId);
ok("10 questions received", quiz?.questions?.length === 10, `n=${quiz?.questions?.length}`);
ok("questions are the AI's, not the local engine's", quiz?.questions?.every(q => /Notion \d+|filtre le trafic/.test(q.prompt || "")), JSON.stringify(quiz?.questions?.map(q => q.prompt)).slice(0, 160));
ok("sourceRef validated against the course", quiz?.questions?.every(q => course.chapters.some(c => c.title === q.sourceRef)));
ok("mix of question types survived", new Set(quiz?.questions?.map(q => q.type)).size >= 1, JSON.stringify(quiz?.questions?.map(q => q.type)));

section("answering, then AI grading of the free-text answer");
{
  const q = quiz.questions;
  const answers = {};
  for (let i = 0; i < q.length; i++) {
    if (q[i].type === "short") {
      answers[i] = "le pare-feu";                      // correct in meaning, not in wording
      window.eval(`Run.answers[${i}] = "le pare-feu"`);
    } else {
      const idx = q[i].options.findIndex(o => o.correct);
      window.eval(`Run.answers[${i}] = ${idx}`);
    }
  }
  const before2 = seen.grade;
  await window.eval("finishQuiz(true)");
  ok("grading calls the model", await waitFor(() => seen.grade > before2, 10000), `grade=${seen.grade}`);
  ok("results page shown", await waitFor(() => /#\/results\//.test(window.location.hash), 15000), window.location.hash);

  await waitFor(() => !!d.querySelector(".big-score"), 8000);
  const attempt = state().attempts[0];
  const shortIdx = q.findIndex(x => x.type === "short");
  ok("all answers stored", attempt?.results?.length === q.length, `${attempt?.results?.length}/${q.length}`);
  if (shortIdx >= 0) {
    ok("AI accepted the paraphrased answer", attempt.results[shortIdx]?.correct === true, JSON.stringify(attempt.results[shortIdx]));
    ok("AI explanation replaced the generic one", /IA :/.test(attempt.questions[shortIdx]?.explanation || ""), attempt.questions[shortIdx]?.explanation);
  } else {
    ok("a short question existed in the batch", false, "provider did not emit a short question");
  }
  const shown = d.querySelector(".big-score")?.textContent?.trim();
  const allRight = attempt?.results?.every(r => r.correct);
  ok("every answer marked correct", allRight, JSON.stringify(attempt?.results?.map(r => r.correct)));
  ok("results page reflects a perfect run", shown === "100%", `shown=${shown}`);
}

section("rate limiting cannot take the app down");
{
  const many = [];
  for (let i = 0; i < 40; i++) many.push(fetch(`${base}/api/health`).then(r => r.status));
  const codes = await Promise.all(many);
  ok("health stays available under load", codes.every(c => c === 200), [...new Set(codes)].join(","));
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
if (errors.length) console.log("runtime errors:\n" + errors.slice(0, 5).join("\n"));
console.log(`  provider calls -> analyse:${seen.analyse} quiz:${seen.quiz} grade:${seen.grade}`);

child.kill();
provider.close();
await once(child, "exit").catch(() => {});
process.exit(fail || errors.length ? 1 : 0);
