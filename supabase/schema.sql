-- Minutes HQ: database setup
-- Paste this whole file into Supabase > SQL Editor > New query and click Run.
-- Run it once on a new project. Nothing to edit: the first person to tap
-- "Start a group" in the app becomes that group's admin.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;   -- random codes and tokens
create extension if not exists pg_trgm  with schema extensions;   -- fuzzy name matching for join requests

-- ============================================================
-- Tables
-- ============================================================

-- A group (e.g. "Board"). Everyone belongs to exactly one.
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  code text not null unique,                       -- join code, e.g. BRD-7Q4K
  time_zone text not null default 'America/Los_Angeles',   -- reminder emails go out at 7 AM here
  created_at timestamptz not null default now()
);

-- Everyone in a group. user_id is set for people who use the app;
-- name-only people (user_id null) attend meetings and can be assigned.
create table public.people (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  user_id uuid unique references auth.users(id) on delete set null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create index people_group_idx on public.people (group_id);

-- Contact details, visible only to the group's admins and the person themself.
create table public.person_private (
  person_id uuid primary key references public.people(id) on delete cascade,
  email text check (email is null or email = lower(email)),
  reminders boolean not null default true,
  unsub_token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  updated_at timestamptz not null default now()
);

-- Someone who entered the group code and is waiting for an admin.
create table public.join_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text,
  full_name text not null,
  suggested_person_id uuid references public.people(id) on delete set null,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  title text not null,
  decision text,
  meeting_title text,
  meeting_date date,
  agenda_item text,
  due_date date,
  status text not null default 'open' check (status in ('open', 'done')),
  done_at timestamptz,
  done_by uuid references public.people(id) on delete set null,
  source_key text unique,
  created_by uuid references public.people(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index items_group_idx on public.items (group_id, status);

create table public.item_assignees (
  item_id uuid not null references public.items(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  primary key (item_id, person_id)
);
create index item_assignees_person_idx on public.item_assignees (person_id);

create table public.item_updates (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  author_id uuid references public.people(id) on delete set null,
  kind text not null default 'note' check (kind in ('note', 'created', 'done', 'reopened', 'meeting')),
  body text not null default '',
  created_at timestamptz not null default now()
);
create index item_updates_item_idx on public.item_updates (item_id, created_at desc);

-- Decisions from the most recent meeting that had any. One list per group.
create table public.decision_lists (
  group_id uuid primary key references public.groups(id) on delete cascade,
  meeting_key text not null,
  meeting_title text,
  meeting_date date,
  started_at timestamptz,
  entries jsonb not null default '[]',             -- [{ "title": ..., "decision": ... }]
  updated_at timestamptz not null default now()
);

-- Each admin's private notes for the next meeting.
create table public.agenda_notes (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 500),
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index agenda_notes_person_idx on public.agenda_notes (person_id, created_at desc);

-- "Live now": only the meeting name and the note-taker's name, while a meeting runs.
-- Notes themselves are broadcast and never stored.
create table public.live_meetings (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  person_id uuid not null unique references public.people(id) on delete cascade,
  meeting_title text not null,
  taker_name text not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Private read-only links in reminder emails. Only a hash of each token is stored.
create table public.link_tokens (
  token_hash text primary key,
  person_id uuid not null references public.people(id) on delete cascade,
  expires_at timestamptz not null
);
create index link_tokens_person_idx on public.link_tokens (person_id);

-- One reminder email per person per day at most.
create table public.reminder_sends (
  person_id uuid not null references public.people(id) on delete cascade,
  sent_on date not null,
  primary key (person_id, sent_on)
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger items_touch before update on public.items for each row execute function public.touch_updated_at();
create trigger person_private_touch before update on public.person_private for each row execute function public.touch_updated_at();

-- ============================================================
-- Who is signed in
-- ============================================================

create or replace function public.me_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.people where user_id = auth.uid()
$$;

create or replace function public.my_group() returns uuid
language sql stable security definer set search_path = public as $$
  select group_id from public.people where user_id = auth.uid()
$$;

create or replace function public.is_group_admin(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.people where user_id = auth.uid() and group_id = g and is_admin)
$$;

create or replace function public.jwt_email() returns text
language sql stable as $$ select lower(nullif(coalesce(auth.jwt() ->> 'email', ''), '')) $$;

-- ============================================================
-- Rules on people
-- ============================================================

create or replace function public.people_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_admin and new.user_id is null then
    raise exception 'Only people who use the app can be admins';
  end if;
  if tg_op = 'UPDATE' and old.is_admin and not new.is_admin and not exists (
      select 1 from public.people where group_id = old.group_id and is_admin and id <> old.id) then
    raise exception 'Make someone else an admin first';
  end if;
  return new;
end $$;
create trigger people_guard before insert or update on public.people for each row execute function public.people_guard();

-- ============================================================
-- Permissions (enforced by the database, not just the app)
-- ============================================================

alter table public.groups          enable row level security;
alter table public.people          enable row level security;
alter table public.person_private  enable row level security;
alter table public.join_requests   enable row level security;
alter table public.items           enable row level security;
alter table public.item_assignees  enable row level security;
alter table public.item_updates    enable row level security;
alter table public.decision_lists  enable row level security;
alter table public.agenda_notes    enable row level security;
alter table public.live_meetings   enable row level security;
alter table public.link_tokens     enable row level security;   -- no policies: server-only
alter table public.reminder_sends  enable row level security;   -- no policies: server-only

-- Signed-out visitors reach the data only through the two link functions below.
revoke all on all tables in schema public from anon;

-- Column-level limits on what signed-in people may write directly.
revoke insert, update on public.groups from authenticated;
grant update (name, time_zone) on public.groups to authenticated;
revoke insert, update on public.people from authenticated;
grant insert (group_id, name) on public.people to authenticated;
grant update (name, is_admin) on public.people to authenticated;
revoke all on public.person_private from authenticated;
grant select (person_id, email, reminders) on public.person_private to authenticated;
grant insert (person_id, email, reminders) on public.person_private to authenticated;
grant update (email, reminders) on public.person_private to authenticated;
revoke insert, update on public.join_requests from authenticated;
revoke insert, update, delete on public.decision_lists from authenticated;
revoke all on public.link_tokens, public.reminder_sends from authenticated;

-- Groups: members see their own group; admins can rename it.
create policy groups_read on public.groups for select to authenticated using (id = public.my_group());
create policy groups_admin_update on public.groups for update to authenticated
  using (public.is_group_admin(id)) with check (public.is_group_admin(id));

-- People: everyone in the group sees the names; admins add, rename, promote, delete name-only people.
create policy people_read on public.people for select to authenticated using (group_id = public.my_group());
create policy people_admin_insert on public.people for insert to authenticated with check (public.is_group_admin(group_id));
create policy people_admin_update on public.people for update to authenticated
  using (public.is_group_admin(group_id)) with check (public.is_group_admin(group_id));
create policy people_admin_delete on public.people for delete to authenticated
  using (public.is_group_admin(group_id) and user_id is null);

-- Contact details: the group's admins, and each person for their own row.
create policy private_read on public.person_private for select to authenticated using (
  person_id = public.me_id() or exists (select 1 from public.people p where p.id = person_id and public.is_group_admin(p.group_id)));
create policy private_admin_write on public.person_private for insert to authenticated with check (
  exists (select 1 from public.people p where p.id = person_id and public.is_group_admin(p.group_id)));
create policy private_update on public.person_private for update to authenticated using (
  person_id = public.me_id() or exists (select 1 from public.people p where p.id = person_id and public.is_group_admin(p.group_id)));

-- Join requests: the requester sees and cancels their own; the group's admins see and decline them.
create policy requests_read on public.join_requests for select to authenticated
  using (user_id = auth.uid() or public.is_group_admin(group_id));
create policy requests_delete on public.join_requests for delete to authenticated
  using (user_id = auth.uid() or public.is_group_admin(group_id));

-- Items: everyone in the group sees them; only admins create, edit and delete.
create policy items_read on public.items for select to authenticated using (group_id = public.my_group());
create policy items_admin on public.items for all to authenticated
  using (public.is_group_admin(group_id)) with check (public.is_group_admin(group_id));

create policy assignees_read on public.item_assignees for select to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and i.group_id = public.my_group()));
create policy assignees_admin on public.item_assignees for all to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and public.is_group_admin(i.group_id)))
  with check (exists (select 1 from public.items i join public.people p on p.group_id = i.group_id
                      where i.id = item_id and p.id = person_id and public.is_group_admin(i.group_id)));

-- Anyone in the group can add an update to any item, always under their own name.
create policy updates_read on public.item_updates for select to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and i.group_id = public.my_group()));
create policy updates_insert on public.item_updates for insert to authenticated
  with check (author_id = public.me_id() and kind in ('note', 'meeting')
              and exists (select 1 from public.items i where i.id = item_id and i.group_id = public.my_group()));
create policy updates_admin_insert on public.item_updates for insert to authenticated
  with check (author_id = public.me_id() and kind = 'created'
              and exists (select 1 from public.items i where i.id = item_id and public.is_group_admin(i.group_id)));
create policy updates_admin_delete on public.item_updates for delete to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and public.is_group_admin(i.group_id)));

-- Decisions list: everyone in the group reads it; it's written only by publish_decisions().
create policy decisions_read on public.decision_lists for select to authenticated using (group_id = public.my_group());

-- Next agenda notes: each admin sees and changes only their own.
create policy notes_own on public.agenda_notes for all to authenticated
  using (person_id = public.me_id())
  with check (person_id = public.me_id() and public.is_group_admin(public.my_group()));

-- Live now: the group's admins see it; only the note-taker writes their own row.
create policy live_read on public.live_meetings for select to authenticated using (public.is_group_admin(group_id));
create policy live_own on public.live_meetings for all to authenticated
  using (person_id = public.me_id())
  with check (person_id = public.me_id() and public.is_group_admin(group_id));

-- ============================================================
-- Functions the app calls
-- ============================================================

-- A short code like BRD-7Q4K: letters from the group name, then 4 random characters.
create or replace function public.new_code(p_name text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  pre text := upper(left(regexp_replace(coalesce(p_name, ''), '[^A-Za-z]', '', 'g'), 3));
  c text; b bytea; i int;
begin
  pre := rpad(pre, 3, 'X');
  loop
    b := extensions.gen_random_bytes(4); c := '';
    for i in 0..3 loop c := c || substr(abc, 1 + (get_byte(b, i) % length(abc)), 1); end loop;
    c := pre || '-' || c;
    exit when not exists (select 1 from public.groups where code = c);
  end loop;
  return c;
end $$;
revoke all on function public.new_code(text) from public, anon, authenticated;

-- Who am I? One call returns the person, the group, or a pending join request.
create or replace function public.whoami() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', public.jwt_email(),
    'person', (select jsonb_build_object('id', p.id, 'name', p.name, 'is_admin', p.is_admin, 'group_id', p.group_id)
               from public.people p where p.user_id = auth.uid()),
    'group', (select jsonb_build_object('id', g.id, 'name', g.name, 'code', case when p.is_admin then g.code end, 'time_zone', g.time_zone)
              from public.people p join public.groups g on g.id = p.group_id where p.user_id = auth.uid()),
    'request', (select jsonb_build_object('full_name', r.full_name, 'group_name', g.name, 'created_at', r.created_at)
                from public.join_requests r join public.groups g on g.id = r.group_id where r.user_id = auth.uid()))
$$;

-- Start a group: anyone signed in who isn't in one yet. They become its admin.
create or replace function public.start_group(p_name text, p_full_name text, p_time_zone text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid; p uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from public.people where user_id = auth.uid()) then raise exception 'You are already in a group'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 or length(trim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'Enter the group name and your name';
  end if;
  delete from public.join_requests where user_id = auth.uid();
  insert into public.groups (name, code, time_zone)
  values (trim(p_name), public.new_code(p_name), coalesce(nullif(p_time_zone, ''), 'America/Los_Angeles'))
  returning id into g;
  insert into public.people (group_id, name, user_id, is_admin) values (g, trim(p_full_name), auth.uid(), true) returning id into p;
  insert into public.person_private (person_id, email) values (p, public.jwt_email());
  return g;
end $$;

-- Score how well a typed full name fits a listed name ("Dana Rodriguez" vs "Dana R.").
create or replace function public.name_score(a text, b text) returns real
language plpgsql immutable set search_path = public as $$
declare
  x text[] := regexp_split_to_array(lower(trim(regexp_replace(a, '[^A-Za-z ]', ' ', 'g'))), '\s+');
  y text[] := regexp_split_to_array(lower(trim(regexp_replace(b, '[^A-Za-z ]', ' ', 'g'))), '\s+');
  s real := extensions.similarity(lower(a), lower(b));
begin
  if array_length(x, 1) >= 1 and array_length(y, 1) >= 1 and x[1] = y[1] then
    s := s + 0.35;
    if array_length(x, 1) >= 2 and array_length(y, 1) >= 2 and left(x[array_length(x, 1)], 1) = left(y[array_length(y, 1)], 1) then
      s := s + 0.3;
    end if;
  end if;
  return s;
end $$;

-- Ask to join a group with its code. The admin approves (and can change the suggested match).
create or replace function public.request_join(p_code text, p_full_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.groups; sug uuid; nm text := trim(coalesce(p_full_name, '')); em text := public.jwt_email();
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from public.people where user_id = auth.uid()) then raise exception 'You are already in a group'; end if;
  if length(nm) = 0 then raise exception 'Enter your full name'; end if;
  select * into g from public.groups
   where regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
  if g.id is null then raise exception 'That code didn''t match a group. Check it with your admin.'; end if;
  -- an email the admin already has on file is an exact match
  select p.id into sug from public.people p join public.person_private pp on pp.person_id = p.id
   where p.group_id = g.id and p.user_id is null and em is not null and pp.email = em limit 1;
  if sug is null then
    select p.id into sug from public.people p
     where p.group_id = g.id and p.user_id is null and public.name_score(nm, p.name) >= 0.45
     order by public.name_score(nm, p.name) desc limit 1;
  end if;
  insert into public.join_requests (group_id, user_id, email, full_name, suggested_person_id)
  values (g.id, auth.uid(), em, nm, sug)
  on conflict (user_id) do update set group_id = excluded.group_id, email = excluded.email, full_name = excluded.full_name,
    suggested_person_id = excluded.suggested_person_id, notified_at = null, created_at = now();
  return jsonb_build_object('group_name', g.name);
end $$;

create or replace function public.cancel_request() returns void
language sql security definer set search_path = public as $$
  delete from public.join_requests where user_id = auth.uid()
$$;

-- Approve a join request: link it to an existing name, or (p_person null) add a new person.
create or replace function public.approve_join(p_request uuid, p_person uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.join_requests; pid uuid;
begin
  select * into r from public.join_requests where id = p_request;
  if r.id is null then raise exception 'That request is gone'; end if;
  if not public.is_group_admin(r.group_id) then raise exception 'Only an admin can approve'; end if;
  if exists (select 1 from public.people where user_id = r.user_id) then
    delete from public.join_requests where id = r.id; raise exception 'That person is already in a group';
  end if;
  if p_person is null then
    insert into public.people (group_id, name, user_id) values (r.group_id, r.full_name, r.user_id) returning id into pid;
  else
    update public.people set user_id = r.user_id
     where id = p_person and group_id = r.group_id and user_id is null returning id into pid;
    if pid is null then raise exception 'That name is already linked to someone'; end if;
  end if;
  insert into public.person_private (person_id, email) values (pid, r.email)
  on conflict (person_id) do update set email = coalesce(public.person_private.email, excluded.email);
  delete from public.join_requests where id = r.id;
  return pid;
end $$;

-- Remove someone from the app. They stay on the list as a name-only person, so history keeps their name.
create or replace function public.remove_member(p_person uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t public.people;
begin
  select * into t from public.people where id = p_person;
  if t.id is null or not public.is_group_admin(t.group_id) then raise exception 'Only an admin can do that'; end if;
  if t.is_admin and not exists (select 1 from public.people where group_id = t.group_id and is_admin and id <> t.id) then
    raise exception 'Make someone else an admin first';
  end if;
  update public.people set is_admin = false where id = t.id and is_admin;
  update public.people set user_id = null where id = t.id;
  delete from public.agenda_notes where person_id = t.id;
  delete from public.live_meetings where person_id = t.id;
end $$;

-- Leave your group (you stay on its list as a name-only person).
create or replace function public.leave_group() returns void
language plpgsql security definer set search_path = public as $$
declare me public.people;
begin
  select * into me from public.people where user_id = auth.uid();
  if me.id is null then return; end if;
  if not exists (select 1 from public.people where group_id = me.group_id and user_id is not null and id <> me.id) then
    raise exception 'You''re the only one using the app in this group. Delete the group instead.';
  end if;
  if me.is_admin and not exists (select 1 from public.people where group_id = me.group_id and is_admin and id <> me.id) then
    raise exception 'Make someone else an admin first';
  end if;
  update public.people set is_admin = false where id = me.id and is_admin;
  update public.people set user_id = null where id = me.id;
  delete from public.agenda_notes where person_id = me.id;
  delete from public.live_meetings where person_id = me.id;
end $$;

-- Delete the whole group: only when you're its only app user.
create or replace function public.delete_group() returns void
language plpgsql security definer set search_path = public as $$
declare me public.people;
begin
  select * into me from public.people where user_id = auth.uid();
  if me.id is null or not me.is_admin then raise exception 'Only an admin can delete the group'; end if;
  if exists (select 1 from public.people where group_id = me.group_id and user_id is not null and id <> me.id) then
    raise exception 'Others still use the app in this group';
  end if;
  delete from public.groups where id = me.group_id;
end $$;

create or replace function public.new_group_code() returns text
language plpgsql security definer set search_path = public as $$
declare g public.groups; c text;
begin
  select * into g from public.groups where id = public.my_group();
  if g.id is null or not public.is_group_admin(g.id) then raise exception 'Only an admin can do that'; end if;
  c := public.new_code(g.name);
  update public.groups set code = c where id = g.id;
  return c;
end $$;

-- Marking done / reopening: any assignee of the item, or an admin.
create or replace function public.set_item_status(p_item uuid, p_done boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := public.me_id(); g uuid;
begin
  select group_id into g from public.items where id = p_item;
  if me is null or g is null or g <> public.my_group() then raise exception 'Item not found'; end if;
  if not (public.is_group_admin(g) or exists (
      select 1 from public.item_assignees where item_id = p_item and person_id = me)) then
    raise exception 'Only someone assigned to this item can change it';
  end if;
  update public.items set
    status  = case when p_done then 'done' else 'open' end,
    done_at = case when p_done then now() else null end,
    done_by = case when p_done then me else null end
  where id = p_item;
  insert into public.item_updates (item_id, author_id, kind, body)
  values (p_item, me, case when p_done then 'done' else 'reopened' end, '');
end $$;

-- Replace the group's Decisions list with this meeting's decisions.
-- Re-ending the same meeting updates it; an older meeting never replaces a newer one.
create or replace function public.publish_decisions(p_key text, p_title text, p_date date, p_started timestamptz, p_entries jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare g uuid := public.my_group(); cur public.decision_lists;
begin
  if g is null or not public.is_group_admin(g) then raise exception 'Only an admin can do that'; end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then return false; end if;
  select * into cur from public.decision_lists where group_id = g;
  if cur.group_id is not null and cur.meeting_key <> p_key
     and coalesce(cur.started_at, '-infinity') > coalesce(p_started, 'infinity') then
    return false;
  end if;
  insert into public.decision_lists (group_id, meeting_key, meeting_title, meeting_date, started_at, entries, updated_at)
  values (g, p_key, p_title, p_date, p_started, p_entries, now())
  on conflict (group_id) do update set meeting_key = excluded.meeting_key, meeting_title = excluded.meeting_title,
    meeting_date = excluded.meeting_date, started_at = excluded.started_at, entries = excluded.entries, updated_at = now();
  return true;
end $$;

-- An admin can cancel someone's private links (the next reminder email carries a new one).
create or replace function public.reset_link(p_person uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.people p where p.id = p_person and public.is_group_admin(p.group_id)) then
    raise exception 'Only an admin can do that';
  end if;
  delete from public.link_tokens where person_id = p_person;
end $$;

-- The private link page: one person's open items, read-only, no sign-in. Nothing about anyone else.
create or replace function public.link_items(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pid uuid;
begin
  select person_id into pid from public.link_tokens
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and expires_at > now();
  if pid is null then return null; end if;
  return (select jsonb_build_object(
    'name', p.name,
    'group', g.name,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'title', i.title, 'due_date', i.due_date, 'meeting_title', i.meeting_title, 'meeting_date', i.meeting_date,
        'latest', (select u.body from public.item_updates u where u.item_id = i.id and u.kind = 'note' order by u.created_at desc limit 1),
        'latest_at', (select u.created_at from public.item_updates u where u.item_id = i.id and u.kind = 'note' order by u.created_at desc limit 1))
        order by i.due_date nulls last, i.title)
      from public.items i join public.item_assignees a on a.item_id = i.id
      where a.person_id = p.id and i.status = 'open'), '[]'::jsonb))
    from public.people p join public.groups g on g.id = p.group_id where p.id = pid);
end $$;

-- One-click unsubscribe from reminder emails.
create or replace function public.unsubscribe(p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.person_private set reminders = false where unsub_token = coalesce(p_token, '');
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Who may call what.
revoke all on function public.start_group(text, text, text), public.request_join(text, text), public.cancel_request(),
  public.approve_join(uuid, uuid), public.remove_member(uuid), public.leave_group(), public.delete_group(),
  public.new_group_code(), public.set_item_status(uuid, boolean),
  public.publish_decisions(text, text, date, timestamptz, jsonb), public.reset_link(uuid), public.whoami(),
  public.link_items(text), public.unsubscribe(text) from public, anon;
grant execute on function public.start_group(text, text, text), public.request_join(text, text), public.cancel_request(),
  public.approve_join(uuid, uuid), public.remove_member(uuid), public.leave_group(), public.delete_group(),
  public.new_group_code(), public.set_item_status(uuid, boolean),
  public.publish_decisions(text, text, date, timestamptz, jsonb), public.reset_link(uuid), public.whoami()
  to authenticated;
grant execute on function public.link_items(text), public.unsubscribe(text) to anon, authenticated;
-- Internal helpers: only signed-in people (the permission rules call them), never signed-out visitors.
revoke all on function public.me_id(), public.my_group(), public.is_group_admin(uuid), public.jwt_email(), public.name_score(text, text) from public, anon;
grant execute on function public.me_id(), public.my_group(), public.is_group_admin(uuid), public.jwt_email(), public.name_score(text, text) to authenticated;
-- Trigger functions are never called directly.
revoke all on function public.people_guard(), public.touch_updated_at() from public, anon, authenticated;
alter function public.touch_updated_at() set search_path = public;
alter function public.jwt_email() set search_path = public;

-- ============================================================
-- Live view: only the group's admins can join a meeting's broadcast channel ("live:<id>").
-- ============================================================
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'realtime' and table_name = 'messages') then
    execute $p$
      create policy live_admins_receive on realtime.messages for select to authenticated using (
        realtime.messages.extension = 'broadcast' and exists (
          select 1 from public.live_meetings l
          where 'live:' || l.id::text = realtime.topic() and public.is_group_admin(l.group_id)))
    $p$;
    execute $p$
      create policy live_admins_send on realtime.messages for insert to authenticated with check (
        realtime.messages.extension = 'broadcast' and exists (
          select 1 from public.live_meetings l
          where 'live:' || l.id::text = realtime.topic() and public.is_group_admin(l.group_id)))
    $p$;
  end if;
end $$;
