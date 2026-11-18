-- Mindview live sync: the server side (Supabase). Run once on the project the app points at (LIVE_URL in src/main.js).
-- Nobody signs in. A room is a long random name (the secret in the live link); the tables cannot be read or listed
-- directly, only through these functions, and each one needs the exact room name.

create table if not exists public.live_docs (
  room text primary key check (room ~ '^[A-Za-z0-9_-]{24,64}$'),
  doc jsonb not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.live_images (
  room text not null references public.live_docs(room) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9]+\.[A-Za-z0-9]+$'),
  data bytea not null check (octet_length(data) <= 8388608),
  created_at timestamptz not null default now(),
  primary key (room, name)
);
alter table public.live_docs enable row level security;
alter table public.live_images enable row level security;
revoke all on public.live_docs, public.live_images from public, anon, authenticated;

-- the current copy of a room
create or replace function public.live_get(p_room text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('version', d.version, 'doc', d.doc) from public.live_docs d where d.room = p_room),
    jsonb_build_object('missing', true));
$$;

-- replace the copy if nobody changed it since p_base (0 = start a new room). Otherwise answer with the newer copy.
create or replace function public.live_put(p_room text, p_base bigint, p_doc jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  if octet_length(p_doc::text) > 10485760 then raise exception 'project too large'; end if;
  if jsonb_typeof(p_doc) <> 'object' then raise exception 'not a project'; end if;
  if p_base = 0 then
    insert into public.live_docs (room, doc) values (p_room, p_doc) on conflict (room) do nothing returning version into v;
  else
    update public.live_docs set doc = p_doc, version = version + 1, updated_at = now()
      where room = p_room and version = p_base returning version into v;
  end if;
  if v is not null then return jsonb_build_object('ok', true, 'version', v); end if;
  return jsonb_build_object('ok', false) || public.live_get(p_room);
end $$;

create or replace function public.live_delete(p_room text) returns boolean
language sql security definer set search_path = '' as $$
  with d as (delete from public.live_docs where room = p_room returning 1) select exists (select 1 from d);
$$;

create or replace function public.live_image_names(p_room text) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(name), '{}') from public.live_images where room = p_room;
$$;

create or replace function public.live_put_image(p_room text, p_name text, p_data text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.live_docs where room = p_room) then return false; end if;
  insert into public.live_images (room, name, data) values (p_room, p_name, decode(p_data, 'base64')) on conflict do nothing;
  return true;
end $$;

create or replace function public.live_get_image(p_room text, p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(data, 'base64') from public.live_images where room = p_room and name = p_name;
$$;

revoke all on function public.live_get(text), public.live_put(text, bigint, jsonb), public.live_delete(text),
  public.live_image_names(text), public.live_put_image(text, text, text), public.live_get_image(text, text) from public;
grant execute on function public.live_get(text), public.live_put(text, bigint, jsonb), public.live_delete(text),
  public.live_image_names(text), public.live_put_image(text, text, text), public.live_get_image(text, text) to anon, authenticated;
