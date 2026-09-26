-- ═══════════════════════════════════════════════════════════════════════════
-- Qraya — accounts, courses, quizzes, mistakes, notes  (Supabase / Postgres)
--
-- OPTIONAL. The app ships working today with on-device storage; this schema is
-- the ready migration for when you want a student's data to follow them between
-- devices. Paste it into Supabase → SQL Editor → New query → Run.
--
-- Every table is protected by row level security: a student can only ever read
-- and write their own rows, enforced by the database rather than by app code.
-- That is what makes requirement §28 ("never expose one user's documents to
-- another") true even if the API is called directly.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── profile ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  level       text check (level in ('bac','prepa','uni')) default 'bac',
  section     text,
  spec        text,
  ui_lang     text default 'fr',
  quiz_lang   text default 'auto',
  created_at  timestamptz default now()
);

-- Create the profile row automatically on signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── documents ──────────────────────────────────────────────────────────────
create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  file_name   text not null,
  byte_size   bigint,
  page_count  int,
  storage_path text,                        -- object key inside the 'courses' bucket
  doc_hash    text,                         -- sha-256 of the text: cache key for analysis
  created_at  timestamptz default now()
);
create index if not exists documents_user_idx on public.documents(user_id, created_at desc);

-- ── courses (the analysis output) ──────────────────────────────────────────
create table if not exists public.courses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  document_id   uuid references public.documents(id) on delete set null,
  title         text not null,
  subject       text,
  lang          text default 'fr',
  pages         int,
  difficulty    text,
  engine        text default 'llm' check (engine in ('llm','local')),
  analysis      jsonb not null,             -- chapters / concepts / formulas / keywords
  keywords      text[],
  created_at    timestamptz default now(),
  last_studied_at timestamptz
);
create index if not exists courses_user_idx on public.courses(user_id, created_at desc);

-- ── quizzes ────────────────────────────────────────────────────────────────
create table if not exists public.quizzes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  config      jsonb not null,               -- count / difficulty / type / scope / lang
  questions   jsonb not null,
  created_at  timestamptz default now()
);
create index if not exists quizzes_user_idx on public.quizzes(user_id, course_id);

-- ── attempts (quiz history: powers weak-area detection over time) ──────────
create table if not exists public.attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  quiz_id      uuid references public.quizzes(id) on delete set null,
  course_id    uuid not null references public.courses(id) on delete cascade,
  results      jsonb not null,              -- [{qId, correct, given}]
  score        int,                         -- 0..100
  duration_ms  int,
  graded_by    text default 'mixed',        -- llm | local | mixed
  created_at   timestamptz default now()
);
create index if not exists attempts_user_idx on public.attempts(user_id, created_at desc);

-- ── mistakes ───────────────────────────────────────────────────────────────
create table if not exists public.mistakes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  quiz_id     uuid references public.quizzes(id) on delete set null,
  q_id        text,
  chapter     text,
  concept     text,
  snapshot    jsonb not null,               -- the full question, so it can be replayed
  wrong       text,
  tries       int default 1,
  mastered    boolean default false,
  created_at  timestamptz default now(),
  retried_at  timestamptz
);
create index if not exists mistakes_user_idx on public.mistakes(user_id, mastered, created_at desc);

-- ── notes ──────────────────────────────────────────────────────────────────
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  body        text not null,
  course_id   uuid references public.courses(id) on delete set null,
  chapter     text,
  q_id        text,
  mistake_id  uuid references public.mistakes(id) on delete set null,
  pinned      boolean default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists notes_user_idx on public.notes(user_id, pinned, updated_at desc);
create index if not exists notes_search_idx on public.notes using gin (to_tsvector('simple', body));

-- ── row level security ─────────────────────────────────────────────────────
alter table public.profiles  enable row level security;
alter table public.documents enable row level security;
alter table public.courses   enable row level security;
alter table public.quizzes   enable row level security;
alter table public.attempts  enable row level security;
alter table public.mistakes  enable row level security;
alter table public.notes     enable row level security;

do $$
declare tbl text;
begin
  foreach tbl in array array['documents','courses','quizzes','attempts','mistakes','notes'] loop
    execute format('drop policy if exists "%s_owner_select" on public.%I', tbl, tbl);
    execute format('drop policy if exists "%s_owner_write"  on public.%I', tbl, tbl);
    execute format('create policy "%s_owner_select" on public.%I for select using (auth.uid() = user_id)', tbl, tbl);
    execute format('create policy "%s_owner_write"  on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)', tbl, tbl);
  end loop;
end $$;

drop policy if exists "profiles_self" on public.profiles;
create policy "profiles_self" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- ── private file storage for the uploaded PDFs ─────────────────────────────
insert into storage.buckets (id, name, public)
values ('courses', 'courses', false)
on conflict (id) do nothing;

drop policy if exists "courses_owner_rw" on storage.objects;
create policy "courses_owner_rw" on storage.objects
  for all to authenticated
  using (bucket_id = 'courses' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'courses' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── convenience: per-chapter performance, the "weak areas" query ───────────
create or replace view public.chapter_performance as
select
  a.user_id,
  a.course_id,
  q.value->>'sourceRef'                      as chapter,
  count(*)                                   as answers,
  count(*) filter (where (r.value->>'correct')::boolean) as correct,
  round(100.0 * count(*) filter (where (r.value->>'correct')::boolean) / greatest(count(*), 1)) as pct
from public.attempts a
  cross join lateral jsonb_array_elements(a.results) as r(value)
  cross join lateral jsonb_array_elements(
    (select questions from public.quizzes z where z.id = a.quiz_id)
  ) as q(value)
where r.value->>'qId' = q.value->>'id'
group by 1, 2, 3;

-- Views bypass RLS by default in Postgres: force the caller's own rows only.
alter view public.chapter_performance set (security_invoker = true);
