-- Order-suffix routing safety net.
--
-- shopify-webhook (v41) routes an order by turning '#26614-SLASHER-TRASH'
-- into 'SLASHER_TRASH' and matching campaigns.legacy_code; anything that
-- doesn't match silently lands on campaign 1. That hid mis-routed Jaws
-- (Jul 2026) and SlasherTrash (Oct 2026) orders for days.
--
-- The webhook is deliberately NOT changed: it must always stamp the raw
-- order. Routing is corrected after the stamp, inside the DB:
--
--   order_suffix_routes          explicit suffix -> campaign aliases for
--                                suffixes that aren't a legacy_code
--                                (campaign_id NULL = acknowledged/ignored)
--   apply_order_suffix_route()   BEFORE trigger on raw_orders. Reads two
--                                small lookup tables and may set
--                                campaign_id. Writes nowhere else, and any
--                                error falls back to the row exactly as
--                                the webhook sent it — it can never block
--                                or drop an order.
--   list_unrouted_order_suffixes / route_order_suffix /
--   ignore_order_suffix          staff RPCs behind the Catalogue inbox.
--
-- Dry run before apply: of 25,739 Shopify orders, 0 change campaign and
-- 0 are flagged once THING_EXPANDED / THE_THING_EXPANDED are seeded (they
-- previously reached campaign 1 only via the default fallback).

-- ── Suffix normaliser — must match legacyCodeFromOrderNumber() in
--    supabase/functions/shopify-webhook/index.ts ─────────────────────────
create or replace function aa_01_campaigns.order_number_suffix(p_order_number text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select upper(replace(substring(p_order_number from '^#?[0-9]+-(.+)$'), '-', '_'))
$$;

revoke all on function aa_01_campaigns.order_number_suffix(text) from anon;

-- ── Routes table ───────────────────────────────────────────────────────
create table if not exists aa_01_campaigns.order_suffix_routes (
  suffix      text primary key check (suffix ~ '^[A-Z0-9_]+$'),
  campaign_id bigint references aa_01_campaigns.campaigns(id) on delete restrict,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

comment on table aa_01_campaigns.order_suffix_routes is
  'Shopify order-number suffix -> campaign, for suffixes that are not a campaigns.legacy_code. campaign_id NULL = acknowledged and ignored (not routed, not flagged). Managed via route_order_suffix / ignore_order_suffix.';

alter table aa_01_campaigns.order_suffix_routes enable row level security;
drop policy if exists "no direct access" on aa_01_campaigns.order_suffix_routes;
create policy "no direct access" on aa_01_campaigns.order_suffix_routes
  for all using (false) with check (false);
revoke all on table aa_01_campaigns.order_suffix_routes from anon, authenticated;

insert into aa_01_campaigns.order_suffix_routes (suffix, campaign_id, note) values
  ('THING_EXPANDED',     1, 'Seeded 2026-10-08: previously reached campaign 1 only via the default fallback'),
  ('THE_THING_EXPANDED', 1, 'Seeded 2026-10-08: previously reached campaign 1 only via the default fallback')
on conflict (suffix) do nothing;

-- ── Trigger: correct campaign_id after the webhook's stamp ─────────────
create or replace function aa_01_campaigns.apply_order_suffix_route()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incoming bigint := NEW.campaign_id;
  v_suffix   text;
  v_target   bigint;
begin
  begin
    if NEW.source_platform = 'shopify' then
      v_suffix := aa_01_campaigns.order_number_suffix(NEW.shopify_order_number);
      if v_suffix is not null then
        select c.id into v_target
          from aa_01_campaigns.campaigns c
         where c.legacy_code = v_suffix
         limit 1;
        if v_target is null then
          select r.campaign_id into v_target
            from aa_01_campaigns.order_suffix_routes r
           where r.suffix = v_suffix;
        end if;
        if v_target is not null then
          NEW.campaign_id := v_target;
        end if;
      end if;
    end if;
  exception when others then
    -- Never block an order: keep exactly what the webhook sent.
    NEW.campaign_id := v_incoming;
    raise warning 'apply_order_suffix_route skipped for order % (%): %',
      NEW.shopify_order_number, sqlstate, sqlerrm;
  end;
  return NEW;
end;
$$;

drop trigger if exists trg_apply_order_suffix_route on aa_01_campaigns.raw_orders;
create trigger trg_apply_order_suffix_route
  before insert or update of shopify_order_number, campaign_id
  on aa_01_campaigns.raw_orders
  for each row
  execute function aa_01_campaigns.apply_order_suffix_route();

-- ── Staff RPCs (admin + team, matching Catalogue access) ───────────────
create or replace function public.list_unrouted_order_suffixes()
returns table (
  suffix                text,
  order_count           bigint,
  sample_order_number   text,
  first_seen            timestamptz,
  last_seen             timestamptz,
  current_campaign_id   bigint,
  current_campaign_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role text := public.current_app_role();
begin
  if v_role is null or v_role not in ('admin', 'team') then
    raise exception 'forbidden: admin or team only' using errcode = '42501';
  end if;

  return query
  with s as (
    select ro.campaign_id, ro.shopify_order_number, ro.created_at,
           aa_01_campaigns.order_number_suffix(ro.shopify_order_number) as sfx
      from aa_01_campaigns.raw_orders ro
     where ro.source_platform = 'shopify'
  ),
  g as (
    select s.sfx,
           count(*)::bigint as n,
           (array_agg(s.shopify_order_number order by s.created_at desc))[1] as sample,
           min(s.created_at) as first_at,
           max(s.created_at) as last_at,
           mode() within group (order by s.campaign_id) as cur
      from s
     where s.sfx is not null
       and not exists (select 1 from aa_01_campaigns.campaigns c where c.legacy_code = s.sfx)
       and not exists (select 1 from aa_01_campaigns.order_suffix_routes r where r.suffix = s.sfx)
     group by s.sfx
  )
  select g.sfx, g.n, g.sample, g.first_at, g.last_at, g.cur, c."Name"::text
    from g
    left join aa_01_campaigns.campaigns c on c.id = g.cur
   order by g.last_at desc;
end;
$$;

create or replace function public.route_order_suffix(
  p_suffix      text,
  p_campaign_id bigint,
  p_note        text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role         text := public.current_app_role();
  v_suffix       text := upper(btrim(p_suffix));
  v_moved        integer := 0;
  v_emails       text[];
  v_customer_ids bigint[];
begin
  if v_role is null or v_role not in ('admin', 'team') then
    raise exception 'forbidden: admin or team only' using errcode = '42501';
  end if;
  if v_suffix is null or v_suffix !~ '^[A-Z0-9_]+$' then
    raise exception 'invalid suffix: %', p_suffix using errcode = '22023';
  end if;
  if p_campaign_id is null
     or not exists (select 1 from aa_01_campaigns.campaigns c where c.id = p_campaign_id) then
    raise exception 'unknown campaign: %', p_campaign_id using errcode = '22023';
  end if;
  if exists (select 1 from aa_01_campaigns.campaigns c
              where c.legacy_code = v_suffix and c.id <> p_campaign_id) then
    raise exception 'suffix % is already the legacy code of another campaign', v_suffix
      using errcode = '23505';
  end if;

  insert into aa_01_campaigns.order_suffix_routes as r (suffix, campaign_id, note, created_by)
  values (v_suffix, p_campaign_id, p_note, auth.uid())
  on conflict (suffix) do update
    set campaign_id = excluded.campaign_id,
        note        = coalesce(excluded.note, r.note),
        created_at  = now(),
        created_by  = excluded.created_by;

  with moved as (
    update aa_01_campaigns.raw_orders ro
       set campaign_id = p_campaign_id
     where ro.source_platform = 'shopify'
       and aa_01_campaigns.order_number_suffix(ro.shopify_order_number) = v_suffix
       and ro.campaign_id is distinct from p_campaign_id
    returning ro.id, ro.email
  )
  select count(distinct m.id)::integer,
         array_agg(distinct lower(btrim(m.email))) filter (where coalesce(btrim(m.email), '') <> ''),
         array_agg(distinct cro.customer_id) filter (where cro.customer_id is not null)
    into v_moved, v_emails, v_customer_ids
    from moved m
    left join aa_02_crm.customer_raw_orders cro on cro.raw_order_id = m.id;

  -- The incremental snapshot jobs only watch customers.updated_at, so a
  -- campaign move on existing orders would otherwise wait for the 3am
  -- reconcile. Refresh just the affected backers now.
  if v_emails is not null then
    perform aa_02_crm.refresh_campaign_backers_for_emails(v_emails);
  end if;
  if v_customer_ids is not null then
    perform aa_02_crm.refresh_customer_list_snapshot_changed(v_customer_ids);
  end if;

  return v_moved;
end;
$$;

create or replace function public.ignore_order_suffix(
  p_suffix text,
  p_note   text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text := public.current_app_role();
  v_suffix text := upper(btrim(p_suffix));
begin
  if v_role is null or v_role not in ('admin', 'team') then
    raise exception 'forbidden: admin or team only' using errcode = '42501';
  end if;
  if v_suffix is null or v_suffix !~ '^[A-Z0-9_]+$' then
    raise exception 'invalid suffix: %', p_suffix using errcode = '22023';
  end if;

  insert into aa_01_campaigns.order_suffix_routes as r (suffix, campaign_id, note, created_by)
  values (v_suffix, null, p_note, auth.uid())
  on conflict (suffix) do update
    set campaign_id = null,
        note        = coalesce(excluded.note, r.note),
        created_at  = now(),
        created_by  = excluded.created_by;
end;
$$;

revoke all on function public.list_unrouted_order_suffixes()        from public, anon;
revoke all on function public.route_order_suffix(text, bigint, text) from public, anon;
revoke all on function public.ignore_order_suffix(text, text)       from public, anon;
grant execute on function public.list_unrouted_order_suffixes()        to authenticated;
grant execute on function public.route_order_suffix(text, bigint, text) to authenticated;
grant execute on function public.ignore_order_suffix(text, text)       to authenticated;
