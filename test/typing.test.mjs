#!/usr/bin/env node
/* Typing & input-flow tests.
 *
 * The app is a form-heavy product: if a field swallows keystrokes, steals focus,
 * or a button stays disabled with no explanation, the student is stuck. These
 * checks type character-by-character into every field like a real person and
 * assert the naive things: the text stays, the focus stays, the button tells you
 * why it is disabled.
 *
 *   npm i -D jsdom && node test/typing.test.mjs
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
  console.log("SKIP  typing tests need jsdom:  npm i -D jsdom");
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
    delete w.fetch;
  },
});
const { window } = dom;
const d = window.document;
window.addEventListener("error", e => errors.push(e.error?.stack || e.message));
process.on("unhandledRejection", r => errors.push("unhandledRejection: " + r));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = () => d.getElementById("app")?.textContent || "";
const hash = async h => { window.location.hash = h; await sleep(200); };
const click = async s => {
  const el = d.querySelector(s);
  if (!el) throw new Error("missing " + s);
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
};
const submit = async s => {
  d.querySelector(s).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(200);
};

/** Type like a human: one keydown/input/keyup per character. */
async function typeInto(sel, text) {
  const el = d.querySelector(sel);
  if (!el) return null;
  el.focus();
  el.value = "";
  for (const ch of text) {
    el.value += ch;
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key: ch, bubbles: true }));
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    el.dispatchEvent(new window.KeyboardEvent("keyup", { key: ch, bubbles: true }));
  }
  await sleep(700); // long enough for any debounced re-render to happen
  const after = d.querySelector(sel);
  return { value: after?.value, kept: after?.value === text, focused: d.activeElement === after };
}

async function field(label, sel, text) {
  const r = await typeInto(sel, text);
  ok(`${label} accepts and keeps typing`, !!(r && r.kept), r ? `kept=${r.kept} got ${r.value?.length}/${text.length} chars` : "field not found");
  ok(`${label} does not lose focus while typing`, !!(r && r.focused), r ? `focused=${r.focused}` : "n/a");
}

section("auth form");
await hash("#/signup");
await field("name", "#f-name", "Ahmed Ben Salah");
await field("email", "#f-mail", "ahmed@exemple.tn");
await field("password", "#f-pass", "motdepasse123");

section("onboarding");
await submit("form[data-auth]");
await sleep(250);
ok("reached onboarding", /Presque terminé|Almost there/.test(txt()), txt().slice(0, 80));
await field("name", "#o-name", "Ahmed");
await click("[data-level='prepa']");
await field("specialization", "#o-spec", "MP");
await submit("form[data-onb]");
await sleep(250);
ok("reached the dashboard", /Bonjour|Bon après-midi|Bonsoir|Good /.test(txt()), txt().slice(0, 80));

section("the paste box is never a dead end");
{
  await hash("#/upload");
  const btn = () => d.querySelector("[data-paste-analyse]");
  const hint = () => d.getElementById("paste-hint")?.textContent || "";

  await typeInto("#paste-text", "court");
  ok("button disabled on almost no text", btn()?.disabled === true);
  ok("the disabled button explains why", /caractères|characters/.test(hint()), hint());
  ok("the hint counts what is missing", /\d/.test(hint()), hint());

  const realCourse = `Chapitre 1 : Les réseaux
Un réseau informatique : ensemble d'équipements reliés entre eux pour échanger des informations.
L'adresse IP est un identifiant numérique unique attribué à chaque machine sur un réseau.`;
  await typeInto("#paste-text", realCourse);
  ok(`a real short course (${realCourse.trim().length} chars) enables the button`, btn()?.disabled === false, `disabled=${btn()?.disabled} len=${realCourse.trim().length}`);
  ok("hint flips to 'ready'", /Prêt|Ready|جاهز/.test(hint()), hint());
  ok("a live character count is shown", /\d/.test(d.getElementById("paste-count")?.textContent || ""), d.getElementById("paste-count")?.textContent);

  await click("[data-paste-analyse]");
  ok("analysis actually starts from that text", /Analyse de votre cours|Course analysis|Chapitres détectés/.test(txt()) || /#\/course\//.test(window.location.hash), txt().slice(0, 100));
  await sleep(2500);
  ok("the short course produced a course page", /#\/course\//.test(window.location.hash), window.location.hash);
}

section("typing is never hijacked");
{
  await hash("#/courses");
  await field("course search", "#course-search", "algo");
  ok("course search filters instead of re-rendering", d.querySelector("#course-search")?.value === "algo");

  await hash("#/notes");
  await field("note search", "#note-search", "réseau");

  await click("[data-note-new]");
  await field("note body", "#nm-text", "Remember that binary search requires sorted data.");
  await click("[data-nm-save]");
  ok("the note was stored with the typed text", window.eval("S.notes.some(n=>/binary search requires sorted/.test(n.text))"), JSON.stringify(window.eval("S.notes.map(n=>n.text)")));

  await hash("#/settings");
  await field("profile name", "#s-name", "Ahmed B.");
  await field("profile email", "#s-mail", "new@exemple.tn");
}

section("the quiz textarea is not stolen by the shortcut keys");
{
  // Start from the demo data so a course exists to build a quiz from.
  window.eval("seedDemo(false)");
  await hash("#/quiz/new?course=c_algo");
  await click("[data-type='short']");
  await click("[data-count='5']");
  await click("[data-generate]");
  await sleep(600);
  ok("on a quiz run", /#\/quiz\/run\//.test(window.location.hash), window.location.hash);

  const answer = "la complexité est logarithmique";
  const r = await typeInto("#short-answer", answer);
  ok("short answer keeps what was typed", r?.kept === true, r ? `got ${r.value?.length} chars` : "no textarea");
  ok("the answer is stored as you type", window.eval("Run.answers[Run.index]") === answer, JSON.stringify(window.eval("Run.answers[Run.index]")));

  // Arrow keys and digits must reach the field, not the quiz navigation.
  const before = window.eval("Run.index");
  const ta = d.querySelector("#short-answer");
  ta.focus();
  ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "2", bubbles: true }));
  await sleep(200);
  ok("arrow keys do not jump the question while typing", window.eval("Run.index") === before, `${before} -> ${window.eval("Run.index")}`);
  ok("digits are not swallowed as answers while typing", d.querySelector("#short-answer")?.value === answer, d.querySelector("#short-answer")?.value);
}

section("mobile keyboard never covers the field");
{
  const ta = d.querySelector("#short-answer");
  ta.focus();
  ta.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  await sleep(60);
  ok("bottom bar hides while a field has focus", d.body.classList.contains("typing"), d.body.className);
  ta.blur();
  ta.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  await sleep(60);
  ok("bottom bar comes back when typing ends", !d.body.classList.contains("typing"), d.body.className);
}

section("no runtime errors during any of it");
ok("clean console", errors.length === 0, errors[0]);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
