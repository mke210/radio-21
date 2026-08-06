create extension if not exists "pgcrypto";

create table if not exists public.audios (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  alumno text default 'Anónimo',
  descripcion text default '',
  publicado boolean default true,
  archivo text,
  url text not null,
  creado_en timestamptz default now()
);

alter table public.audios add column if not exists descripcion text default '';
alter table public.audios add column if not exists publicado boolean default true;

alter table public.audios enable row level security;

drop policy if exists "audios_select_all" on public.audios;
create policy "audios_select_all"
on public.audios
for select
using (true);

drop policy if exists "audios_insert_all" on public.audios;
create policy "audios_insert_all"
on public.audios
for insert
with check (true);

drop policy if exists "audios_update_all" on public.audios;
create policy "audios_update_all"
on public.audios
for update
using (true)
with check (true);

drop policy if exists "audios_delete_all" on public.audios;
create policy "audios_delete_all"
on public.audios
for delete
using (true);

insert into storage.buckets (id, name, public)
values ('audios', 'audios', true)
on conflict (id) do update set public = true;

drop policy if exists "audios_files_select" on storage.objects;
create policy "audios_files_select"
on storage.objects
for select
using (bucket_id = 'audios');

drop policy if exists "audios_files_insert" on storage.objects;
create policy "audios_files_insert"
on storage.objects
for insert
with check (bucket_id = 'audios');

drop policy if exists "audios_files_delete" on storage.objects;
create policy "audios_files_delete"
on storage.objects
for delete
using (bucket_id = 'audios');