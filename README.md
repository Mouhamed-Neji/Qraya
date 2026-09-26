# Qraya · قراية

**Turn your course into a quiz.** An AI study platform for Tunisian Bac & Prépa students:
upload a course PDF → the AI understands it → generate a quiz → get corrections and
explanations → find your weak areas → practise your mistakes.

This repository is a complete, deployable website. **It costs nothing to run**: free
hosting, free AI tier, no database required.

---

## Run it on your own machine (30 seconds)

```bash
cd qraya
node dev-server.mjs
# → http://localhost:3000
```

That's it — no `npm install` (there are zero dependencies), no build step.
**Without any API key the site already works**, using the built-in on-device
analysis engine. The AI badge in the app tells you which engine is active.

### Add real AI (free, no credit card)

1. Go to **https://aistudio.google.com/apikey** → *Create API key*
2. Copy `.env.example` to `.env` and paste it:

```bash
cp .env.example .env
# then edit .env:  GEMINI_API_KEY=AIza...
```

3. Restart `node dev-server.mjs`. The badge switches to `Google Gemini · gemini-…`
   and every course is now read, questioned and corrected by a real model.

Alternative free providers (set only one): `GROQ_API_KEY`
(https://console.groq.com/keys), `OPENROUTER_API_KEY` (free `:free` models), or any
OpenAI-compatible endpoint (Ollama, LM Studio, vLLM) via `LLM_BASE_URL`.

---

## Put it online for free (Vercel)

Vercel's Hobby plan hosts the website **and** the API for free.

**1. Push the folder to GitHub**

```bash
cd qraya
git init && git add -A && git commit -m "Qraya"
git branch -M main
git remote add origin https://github.com/<you>/qraya.git
git push -u origin main
```

**2. Import it on Vercel** → https://vercel.com/new → pick the repo → **Deploy**.
No framework preset needed; `vercel.json` already configures the static site and
the functions.

**3. Add your key** → Vercel project → *Settings → Environment Variables* →
`GEMINI_API_KEY` = your key → *Redeploy*. Done — the site is live on a free
`*.vercel.app` domain (attach your own domain later for free too).

> Verify it worked: open `https://your-app.vercel.app/api/health`.
> `{"ai":true,...}` means real AI is live. `{"ai":false}` means the site is
> running on the on-device engine (still fully usable) — check the env var name.

Prefer Cloudflare or Netlify? The `api/*.js` files are plain Web-standard
handlers (`Request → Response`), so they run on Cloudflare Workers with a thin
adapter, and the repo works on Netlify Functions and any Node host unchanged.

### Free-tier notes worth knowing

- **Vercel Hobby is for personal, non-commercial projects.** For a commercial
  launch you'd move to Pro, or host the same code on Cloudflare Workers (free
  tier allows commercial use). Worth planning for if this grows into a product.
- A Vercel function can receive **4.5 MB** of request body, which is why the PDF
  is parsed **in the browser** and only the extracted text is sent to the API.
- Hobby functions run up to **300 s**; the heaviest call here (a 30-question quiz)
  takes a few tens of seconds.
- Free model tiers are rate limited (~10–30 requests/minute). The backend
  serialises its model calls and retries with backoff, so a burst of students
  degrades into *waiting*, never into errors.

---

## How it works

```
Browser (public/index.html — one self-contained file)
│  • reads the PDF with pdf.js (text layer), or accepts pasted text
│  • knows the student's courses, quizzes, mistakes and notes locally
│  • has a complete on-device question engine as a fallback
│
├─ POST /api/analyse   text → chapters, concepts, formulas, keywords   (model)
├─ POST /api/quiz      course + settings → questions with explanations (model)
├─ POST /api/grade     free-text answers → correct? + why              (model)
└─ GET  /api/health    which provider/model is live                    (no key needed)

lib/llm.js       provider adapter: Gemini / Groq / OpenRouter / OpenAI / any
lib/prompts.js   the prompts and JSON schemas (server-side only)
lib/limits.js    per-visitor rate limits + analysis cache
supabase/schema.sql  optional accounts + storage (see below)
```

**Nothing about the prompts or the key ever reaches the browser.** The client can
only ask the endpoints, and every endpoint validates its input.

### The fallback is the point

If the backend is missing, has no key, is rate limited, times out, or the model
returns garbage, every call returns `null` and the app falls back to its own
engine. A student never sees a broken screen because of an API problem. The badge
in the app always tells you which engine produced the current course.

The server never invents content either: if the material genuinely doesn't
contain enough to build a quiz, it says so ("This course doesn't contain enough
clear information for a full quiz") instead of manufacturing questions.

### Robustness that is already handled for you

| Free-tier reality | How it's handled |
|---|---|
| `429` rate limits | serialised calls + exponential backoff honouring `Retry-After` |
| Provider rejects `json_schema` | automatic ladder: `json_schema` → `json_object` → plain JSON in prompt |
| Model wraps JSON in ``` fences / adds trailing commas | extraction + structural repair, then one validation retry |
| Model names get renamed (`2.5-flash` → `3.8-flash`) | `GET /models` discovery with a preference order, cached |
| Model repeats a question in a later batch | each batch is told what was already asked; duplicates dropped and topped up |
| Ambiguous MCQ (0 or 2 correct options) | discarded server-side, never shown to a student |
| Same PDF uploaded twice | analysis cached by content hash |

---

## Tests

```bash
npm install            # only jsdom, only for the tests (the app itself has 0 deps)
npm test               # runs all four suites
```

| Suite | Checks | What it proves |
|---|---|---|
| `test/api.test.mjs` | 49 | the backend, no key and no network needed |
| `test/offline.test.mjs` | 27 | the whole student flow with no backend at all |
| `test/browser-ai.test.mjs` | 24 | the real UI → real API → model chain |
| `test/typing.test.mjs` | 40 | every field accepts and keeps typing, buttons explain themselves |

Both AI suites point the backend at a deliberately misbehaving fake provider
(429 on the first call, a provider that refuses structured output, malformed
JSON, repeated questions) — so the failure paths are exercised, not just the
happy path.

---

## If something doesn't work

| Symptom | Cause | Fix |
|---|---|---|
| The badge says *on-device analysis* and you want real AI | no key seen by the server | check `GEMINI_API_KEY` is set **and redeploy**; confirm with `/api/health` → `"ai":true` |
| "We couldn't read this PDF" | the PDF is scanned (an image, no text layer) or password-protected | use the **Paste the course text** button on that screen, or upload a text-based PDF |
| "This course doesn't contain enough clear information" | the extractable text has too few definitions to question fairly | paste a fuller section of the course |
| The paste button stays disabled | fewer than 120 characters in the box | the line under the box tells you exactly how many more you need |
| A field won't take text | there is no such bug in the app (all 12 fields are covered by `test/typing.test.mjs`) | make sure you are on the deployed site or running `node dev-server.mjs`, not viewing the HTML through an editor preview |

## Accounts & sync (optional, not enabled yet)

Today a student's courses, quizzes, mistakes and notes are stored **on their
device** (`localStorage`). That means the app works instantly with zero setup —
and the trade-off is that data doesn't follow them to another phone.

`supabase/schema.sql` is the ready migration for that: profiles, documents,
courses, quizzes, attempts, mistakes, notes, a private storage bucket for the
PDFs, and row-level security on every table so one student can never read
another's data. Create a free Supabase project, paste that file into the SQL
editor, and tell me — I'll wire the client to it (auth screens, sync, and
per-user storage) so the accounts work across devices.

---

## Limits (tunable in `.env`)

| Variable | Default | Meaning |
|---|---|---|
| `MAX_TEXT_CHARS` | 120000 | reject bigger course texts |
| `MAX_QUESTIONS` | 30 | cap per quiz |
| `RATE_IP_PER_HOUR` | 30 | AI calls per visitor per hour |
| `RATE_IP_PER_DAY` | 120 | AI calls per visitor per day |
| `FREE_DAILY_LIMIT` | 0 (unlimited) | global daily AI calls — set this before sharing the link publicly |
| `LLM_MODEL` | auto | pin a model instead of auto-detecting |
| `LLM_CONCURRENCY` | 1 | parallel model calls; keep 1 on free tiers |

Rate limits are per server instance (serverless doesn't share memory), which
stops a single abusive visitor. For a hard global cap on a public launch, set
`FREE_DAILY_LIMIT` and swap `Counter` in `lib/limits.js` for a shared store
(Upstash Redis has a free tier) — one small change, and the app won't change.

---

## Licence

MIT — use it, fork it, ship it. The name and the copy are yours to change.
