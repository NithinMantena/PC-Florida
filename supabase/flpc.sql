-- Florida P&C data API: database setup for a SHARED Supabase project.
--
-- Everything lives in its own schema, `flpc`, so it sits next to the project's
-- existing tables (e.g. the reading list) without touching them. The schema is
-- not exposed through the project's REST API: only the `flpc` Edge Function
-- (which connects to Postgres directly) and the Postgres roles below can read it.
--
-- Run this whole file once in the Supabase dashboard -> SQL Editor. It is
-- idempotent: re-running it after pulling a newer version upgrades in place and
-- keeps the loaded data and API tokens. (Re-running also rotates the internal
-- password of the read-only SQL role; nothing needs to be updated for that.)
--
-- Afterwards, create API tokens (shown once, stored hashed):
--   select * from flpc.create_token('loader', 3650, '{load}');   -- GitHub Action / ETL upload
--   select * from flpc.create_token('claude', 365);               -- read access for a chatbot
-- List / revoke:
--   select * from flpc.tokens;
--   select flpc.revoke_token('claude');

create schema if not exists flpc;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Data tables (replaced as a whole by flpc.load_bundle on every data load).
-- Shapes mirror the local SQLite store written by etl/ingest.py.
-- ---------------------------------------------------------------------------

create table if not exists flpc.meta (key text primary key, value text);

create table if not exists flpc.periods (
  period text primary key, idx int not null, year int, quarter int,
  period_end text, pulled_at text, source_file text);

create table if not exists flpc.companies (
  naic text primary key, name text, names text, group_id text, group_name text,
  first_period text, last_period text, ord int);

create table if not exists flpc.groups (
  group_id text primary key, group_name text, standalone int, members text, ord int);

create table if not exists flpc.policy_types (
  pt_id text primary key, policy_type text, line text, product text, wind_only int);

create table if not exists flpc.metrics (
  metric text primary key, first_period text, last_period text, n_periods int);

-- Metric columns are numeric so sums are exact; the loader adds a column for
-- any new metric a future workbook introduces.
create table if not exists flpc.facts (
  period text not null, idx int not null, naic text not null, group_id text, pt_id text not null,
  line text, product text, wind_only int,
  pif numeric, pif_incl_wind numeric, pif_excl_wind numeric,
  tiv numeric, tiv_incl_wind numeric, tiv_excl_wind numeric,
  dpw numeric, dpw_incl_wind numeric, dpw_excl_wind numeric,
  new_written numeric, received_in numeric, transferred_out numeric,
  cancelled numeric, cancelled_hurricane numeric, nonrenewed numeric, nonrenewed_hurricane numeric,
  claims_opened numeric, claims_closed numeric, claims_pending numeric,
  claims_adr numeric, claims_mediation numeric, claims_arbitration numeric, claims_appraisal numeric,
  claims_sinkhole_eval numeric, claims_settlement_conf numeric, claims_adr_other numeric,
  lawsuits_opened numeric, lawsuits_closed numeric, lawsuits_closed_consumer numeric,
  lawsuits_open_begin numeric, lawsuits_open_end numeric,
  primary key (period, naic, pt_id));
create index if not exists facts_idx on flpc.facts (idx);
create index if not exists facts_naic on flpc.facts (naic);
create index if not exists facts_group on flpc.facts (group_id);

create table if not exists flpc.suppressed (period text, naic text, pt_id text, metric text);
create index if not exists suppressed_key on flpc.suppressed (period, naic, pt_id);

create table if not exists flpc.published_totals (file_type text, period text, metric text, value double precision);

create table if not exists flpc.summary_a (
  period text, naic text, company text,
  a_pif double precision, a_pif_commercial double precision, a_pif_personal double precision,
  a_dpw double precision, a_dpw_commercial double precision, a_dpw_personal double precision);

-- ---------------------------------------------------------------------------
-- Administration (never readable by the API's SQL role)
-- ---------------------------------------------------------------------------

create table if not exists flpc.loads (
  load_id uuid primary key, loaded_at timestamptz not null default now(), token_name text,
  generated_at text, latest_period text, periods int, rows jsonb, source_files jsonb);

create table if not exists flpc.api_tokens (
  id bigint generated always as identity primary key,
  name text not null,
  token_hash text not null unique,              -- sha256 hex of the token; the token itself is never stored
  scopes text[] not null default '{read}',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint api_tokens_scopes check (scopes <@ array['read', 'load']::text[] and cardinality(scopes) > 0));
create unique index if not exists api_tokens_active_name on flpc.api_tokens (name) where revoked_at is null;

create table if not exists flpc.secrets (key text primary key, value text not null);

create or replace view flpc.tokens as
  select id, name, scopes, created_at, expires_at, revoked_at, last_used_at,
         case when revoked_at is not null then 'revoked'
              when expires_at is not null and expires_at <= now() then 'expired'
              else 'active' end as status
  from flpc.api_tokens order by id;

create or replace function flpc.create_token(p_name text, p_days int default 365, p_scopes text[] default '{read}')
returns table (name text, token text, scopes text[], expires_at timestamptz)
language plpgsql
set search_path = flpc, pg_catalog
as $$
declare
  t text := 'flpc_' || translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  exp timestamptz := case when p_days is null then null else now() + make_interval(days => p_days) end;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'token name is required';
  end if;
  if exists (select 1 from flpc.api_tokens a where a.name = p_name and a.revoked_at is null) then
    raise exception 'an active token named % already exists; revoke it first: select flpc.revoke_token(%)',
      p_name, quote_literal(p_name);
  end if;
  insert into flpc.api_tokens (name, token_hash, scopes, expires_at)
  values (p_name, encode(extensions.digest(t, 'sha256'), 'hex'), p_scopes, exp);
  return query select p_name, t, p_scopes, exp;
end;
$$;

create or replace function flpc.revoke_token(p_name text)
returns int
language sql
set search_path = flpc, pg_catalog
as $$
  with r as (update flpc.api_tokens set revoked_at = now()
             where name = p_name and revoked_at is null returning 1)
  select count(*)::int from r;
$$;

-- ---------------------------------------------------------------------------
-- Data load: replace every data table from one bundle, in one transaction.
-- Readers keep seeing the previous data until it commits.
-- Bundle: {"format": 1, "generated_at": ..., "tables": {name: {"columns": [...], "rows": [[...], ...]}}}
-- (written by etl/ingest.py --bundle / --push).
-- ---------------------------------------------------------------------------

create or replace function flpc.load_bundle(p jsonb, p_token_name text default null)
returns jsonb
language plpgsql
set search_path = flpc, pg_catalog
as $$
declare
  tables constant text[] := array['meta', 'periods', 'companies', 'groups', 'policy_types', 'metrics',
                                  'facts', 'suppressed', 'published_totals', 'summary_a'];
  t text;
  c text;
  cols text[];
  typ text;
  ins_cols text;
  sel_exprs text;
  n int;
  counts jsonb := '{}';
  lid uuid := gen_random_uuid();
  pos int;
begin
  if coalesce((p ->> 'format')::int, 0) <> 1 then
    raise exception 'unsupported bundle format %', p ->> 'format';
  end if;
  foreach t in array tables loop
    if jsonb_typeof(p -> 'tables' -> t -> 'rows') is distinct from 'array'
       or jsonb_typeof(p -> 'tables' -> t -> 'columns') is distinct from 'array' then
      raise exception 'bundle is missing table %', t;
    end if;
  end loop;
  if jsonb_array_length(p -> 'tables' -> 'facts' -> 'rows') = 0
     or jsonb_array_length(p -> 'tables' -> 'periods' -> 'rows') = 0 then
    raise exception 'bundle has no facts/periods; refusing to replace the loaded data with nothing';
  end if;

  -- a metric column a newer workbook introduced
  for c in select x from jsonb_array_elements_text(p -> 'tables' -> 'facts' -> 'columns') x loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'flpc' and table_name = 'facts' and column_name = c) then
      if c !~ '^[a-z][a-z0-9_]{0,62}$' then
        raise exception 'bad metric column name %', c;
      end if;
      execute format('alter table flpc.facts add column %I numeric', c);
    end if;
  end loop;

  foreach t in array tables loop
    select array_agg(x order by o) into cols
    from jsonb_array_elements_text(p -> 'tables' -> t -> 'columns') with ordinality a(x, o);
    ins_cols := '';
    sel_exprs := '';
    pos := 0;
    foreach c in array cols loop
      select format_type(atttypid, atttypmod) into typ
      from pg_attribute where attrelid = format('flpc.%I', t)::regclass and attname = c and not attisdropped;
      if typ is null then
        raise exception 'table % has no column % (update supabase/flpc.sql)', t, c;
      end if;
      ins_cols := ins_cols || format('%I, ', c);
      sel_exprs := sel_exprs || format('(r.v ->> %s)::%s, ', pos, typ);
      pos := pos + 1;
    end loop;
    if t in ('companies', 'groups') then           -- keep source order for stable tie-breaking
      ins_cols := ins_cols || 'ord, ';
      sel_exprs := sel_exprs || 'r.o::int, ';
    end if;
    execute format('delete from flpc.%I', t);
    execute format('insert into flpc.%I (%s) select %s from jsonb_array_elements($1) with ordinality r(v, o)',
                   t, left(ins_cols, -2), left(sel_exprs, -2))
      using p -> 'tables' -> t -> 'rows';
    get diagnostics n = row_count;
    counts := counts || jsonb_build_object(t, n);
  end loop;

  insert into flpc.meta (key, value) values ('load_id', lid::text), ('loaded_at', now()::text)
  on conflict (key) do update set value = excluded.value;

  insert into flpc.loads (load_id, token_name, generated_at, latest_period, periods, rows, source_files)
  select lid, p_token_name, p ->> 'generated_at',
         (select max(period) from flpc.periods), (select count(*) from flpc.periods), counts,
         (select value::jsonb from flpc.meta where key = 'source_files');
  delete from flpc.loads where load_id not in (select load_id from flpc.loads order by loaded_at desc limit 50);

  return jsonb_build_object('load_id', lid, 'rows', counts,
                            'periods', (select count(*) from flpc.periods),
                            'latest_period', (select period from flpc.periods order by idx desc limit 1));
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock it down. Nothing in flpc is reachable by the project's anon /
-- authenticated API roles; the Edge Function connects as the owner.
-- ---------------------------------------------------------------------------

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema flpc from %I', r);
      execute format('revoke all on all tables in schema flpc from %I', r);
      execute format('revoke all on all functions in schema flpc from %I', r);
    end if;
  end loop;
end $$;
revoke all on schema flpc from public;
revoke all on all functions in schema flpc from public;

do $$
declare t text;
begin
  foreach t in array array['meta', 'periods', 'companies', 'groups', 'policy_types', 'metrics', 'facts',
                           'suppressed', 'published_totals', 'summary_a', 'loads', 'api_tokens', 'secrets'] loop
    execute format('alter table flpc.%I enable row level security', t);
  end loop;
end $$;

-- Read-only role for the run_sql tool. It can log in only with a random
-- password kept in flpc.secrets (which it cannot read); the Edge Function
-- fetches it. It sees the data tables only (not tokens, loads or secrets), in
-- read-only transactions with a 5 s statement limit.
do $$
declare pw text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not exists (select 1 from pg_roles where rolname = 'flpc_reader') then
    execute format('create role flpc_reader login noinherit password %L connection limit 5', pw);
  else
    execute format('alter role flpc_reader login noinherit password %L connection limit 5', pw);
  end if;
  insert into flpc.secrets (key, value) values ('reader_password', pw)
  on conflict (key) do update set value = excluded.value;
end $$;
alter role flpc_reader set default_transaction_read_only = on;
alter role flpc_reader set statement_timeout = '5s';
alter role flpc_reader set idle_in_transaction_session_timeout = '10s';
alter role flpc_reader set search_path = flpc;

grant usage on schema flpc to flpc_reader;
do $$
declare t text;
begin
  foreach t in array array['meta', 'periods', 'companies', 'groups', 'policy_types', 'metrics', 'facts',
                           'suppressed', 'published_totals', 'summary_a'] loop
    execute format('grant select on flpc.%I to flpc_reader', t);
    if not exists (select 1 from pg_policies where schemaname = 'flpc' and tablename = t
                   and policyname = 'reader_select') then
      execute format('create policy reader_select on flpc.%I for select to flpc_reader using (true)', t);
    end if;
  end loop;
end $$;
