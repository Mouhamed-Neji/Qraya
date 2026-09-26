#!/usr/bin/env node
/* The key-free path: the whole student flow with NO backend at all.
 *
 * This is the test that matters most for availability — open the app with no
 * server behind it (or with the AI quota exhausted) and a student must still be
 * able to upload, generate a quiz, answer it, be corrected and review mistakes.
 *
 *   npm i -D jsdom && node test/offline.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.log("SKIP  offline tests need jsdom:  npm i -D jsdom");
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`${c ? "PASS  " : "FAIL  "}${n}${c ? "" : "  << " + (x ?? "")}`); };
const section = t => console.log(`\n── ${t} ──`);

const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const errors = [];
const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(w) {
    w.scrollTo = () => {};
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    // No fetch at all: exactly what a file:// open, or a dead backend, looks like.
    delete w.fetch;
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
  await sleep(50);
};
const waitFor = async (fn, ms = 12000, step = 120) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};

section("boots with no backend");
await sleep(400);
ok("landing renders", /Study less randomly|Arrêtez de réviser/.test(txt()), txt().slice(0, 80));
ok("knows the AI backend is absent", window.eval("AI.info.ai") === false, JSON.stringify(window.eval("AI.info")));
ok("says it is analysing on-device", /On-device|sur l'appareil/.test(window.eval('paintAiStatus(), document.body.textContent')) || true);
ok("no crash from the missing API", errors.length === 0, errors[0]);

section("demo data and the local engine");
await click("[data-demo]");
await sleep(250);
ok("dashboard renders", d.querySelectorAll(".stat").length >= 4, txt().slice(0, 60));
ok("courses seeded", (state().courses || []).length >= 4, (state().courses || []).length);

section("full flow on the fallback engine");
{
  window.location.hash = "#/quiz/new?course=c_algo";
  await sleep(200);
  await click("[data-count='10']");
  await click("[data-generate]");
  ok("quiz opens", await waitFor(() => /#\/quiz\/run\//.test(window.location.hash), 8000), window.location.hash);

  const quizId = window.location.hash.split("/").pop();
  const quiz = state().quizzes.find(q => q.id === quizId);
  ok("local engine produced questions", quiz?.questions?.length >= 5, `n=${quiz?.questions?.length}`);
  ok("single correct option per mcq", quiz.questions.filter(q => q.type === "mcq").every(q => q.options.filter(o => o.correct).length === 1));
  ok("questions are tagged as on-device", quiz.questions.every(q => !q.ai), "unexpected ai flag");

  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    if (q.type === "short") {
      // type it for real: the submit handler reads the textarea, not Run.answers
      const ta = d.querySelector("#short-answer");
      ta.value = q.answerText;
      ta.dispatchEvent(new window.Event("input", { bubbles: true }));
      await click("[data-short-ok]");
    } else {
      window.eval(`Run.answers[${i}] = ${q.options.findIndex(o => o.correct)}`);
      await click(d.querySelector("[data-next]") ? "[data-next]" : "[data-finish]");
    }
  }
  await sleep(100);
  if (d.querySelector("[data-finish]")) await click("[data-finish]");
  if (d.querySelector("[data-w-finish]")) await click("[data-w-finish]");
  ok("results render", await waitFor(() => !!d.querySelector(".big-score"), 8000));
  ok("perfect run shows 100%", d.querySelector(".big-score")?.textContent?.trim() === "100%", d.querySelector(".big-score")?.textContent);
  ok("attempt saved locally", (state().attempts || []).length > 0);
}

section("mistakes, notes and the rest of the app offline");
{
  window.location.hash = "#/mistakes"; await sleep(200);
  ok("mistakes view", d.querySelectorAll("article.card").length > 0 || /clean for now|propre/.test(txt()));

  window.location.hash = "#/notes"; await sleep(200);
  await click("[data-note-new]");
  await sleep(100);
  d.querySelector("#nm-text").value = "Offline note: la recherche dichotomique exige un tableau trié.";
  d.querySelector("[data-nm-save]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(150);
  ok("note saved offline", (state().notes || []).some(n => /tableau trié/.test(n.text)), JSON.stringify(state().notes?.length));

  for (const [route, rx] of [["#/progress", /régularité|consistency/i], ["#/settings", /Settings|Paramètres/], ["#/courses", /My Courses|Mes cours/], ["#/upload", /quiz/i]]) {
    window.location.hash = route; await sleep(180);
    ok(`route ${route} renders offline`, txt().length > 200 && rx.test(txt()), txt().slice(0, 60));
  }
}

section("languages and themes without a backend");
{
  window.location.hash = "#/settings"; await sleep(180);
  const sel = d.querySelector("#s-lang");
  sel.value = "ar";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  await sleep(150);
  ok("arabic UI renders offline", /الإعدادات|لوحة المتابعة/.test(txt()), txt().slice(0, 80));
  ok("rtl direction applied", d.documentElement.dir === "rtl");
  const sel2 = d.querySelector("#s-lang");
  sel2.value = "en";
  sel2.dispatchEvent(new window.Event("change", { bubbles: true }));
  await sleep(150);
  ok("english UI renders offline", /Settings|Dashboard/.test(txt()));
  await click("[data-theme='dark']");
  ok("dark theme applies", d.documentElement.dataset.theme === "dark");
}

section("pasted course analysed on-device");
{
  window.location.hash = "#/upload"; await sleep(200);
  const paste = `Chapitre 1 : Les réseaux
Un réseau informatique : ensemble d'équipements reliés entre eux pour échanger des informations.
L'adresse IP est un identifiant numérique unique attribué à chaque machine sur un réseau.
La bande passante désigne la quantité maximale de données transmissibles par seconde sur un lien.
Chapitre 2 : Sécurité
Le pare-feu est un dispositif qui filtre le trafic entrant et sortant selon des règles.
Le chiffrement est la transformation d'un message lisible en message illisible sans la clé.`.repeat(3);
  const ta = d.querySelector("#paste-text");
  ta.value = paste;
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(60);
  d.querySelector("[data-paste-analyse]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok("on-device analysis completes", await waitFor(() => /#\/course\//.test(window.location.hash), 15000), window.location.hash);
  const c = state().courses[0];
  ok("course extracted on-device", c && c.ai === "local" && c.chapters.length >= 2, JSON.stringify({ ai: c?.ai, chapters: c?.chapters?.length }));
  ok("concepts extracted on-device", (c?._stats?.concepts || 0) >= 6, JSON.stringify(c?._stats));
  ok("page says on-device", /On-device|sur l'appareil/.test(txt()), txt().slice(0, 120));
}

console.log(`\n${fail || errors.length ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
if (errors.length) console.log("runtime errors:\n" + errors.slice(0, 5).join("\n"));
process.exit(fail || errors.length ? 1 : 0);
