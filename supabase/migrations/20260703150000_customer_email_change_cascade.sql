-- Cascading customer email change.
--
-- Email is used as a linkage key on 9 live tables. There are no FK
-- constraints — every join is text-based `lower(trim(x.email)) =
-- lower(trim(y.email))`. Manually UPDATE-ing customers.email would
-- orphan the customer from every order, ticket, payhere row, etc.
--
-- This migration adds:
--   1. aa_02_crm.customer_email_change_log — audit table.
--   2. public.preview_customer_email_change(customer_id, new_email)
--        Read-only; returns per-table row counts + collision flag so
--        the UI can show "N orders, N tickets, N historic orders,
--        etc. will move" before the operator commits.
--   3. public.admin_change_customer_email(customer_id, new_email, note)
--        Owner-only. Wraps all 8 tables + customers itself in a single
--        transaction, records counts to the audit log, kicks incremental
--        snapshot refreshes for both emails so the UI is fresh instantly.
--        Materialized views (mv_raw_order_line_attribution +
--        mv_contact_campaign_engagement) refresh on their normal cron;
--        they only feed segment/attribution surfaces, not the customer
--        page.
--
-- Freshdesk handling (decision: v1 = DB-only):
--   * tickets.customer_id (bigint junction FK) is stable — tickets stay
--     linked to the customer through the ID.
--   * tickets.requester_email is DELIBERATELY NOT UPDATED. Freshdesk is
--     source of truth; the next webhook event on that ticket would
--     overwrite our change anyway. The ticket page will continue to
--     show whatever Freshdesk knows (which is the old email). Audit log
--     records the count of tickets touched but not modified.
--
-- Refuses to run if:
--   * new_email is blank / not shaped like an email
--   * new_email equals old_email (no-op)
--   * new_email already belongs to a different customer (collision —
--     that's a merge-customers operation, out of scope)
--   * caller is not owner + admin

create table if not exists aa_02_crm.customer_email_change_log (
  id                bigint generated always as identity primary key,
  customer_id       bigint not null,
  old_email         text   not null,
  new_email         text   not null,
  changed_by        uuid,
  changed_at        timestamptz not null default now(),
  counts            jsonb  not null default '{}'::jsonb,
  note              text
);

grant select on aa_02_crm.customer_email_change_log to authenticated;

-- Preview: what will move? Read-only.
create or replace function public.preview_customer_email_change(
  p_customer_id bigint,
  p_new_email   text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, aa_01_campaigns, aa_02_crm
as $$
declare
  v_old_email  text;
  v_new_email  text := lower(trim(coalesce(p_new_email, '')));
  v_collision  bigint;
  v_counts     jsonb;
begin
  if public.current_app_role() is null then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;

  select lower(trim(email)) into v_old_email
  from aa_02_crm.customers where id = p_customer_id;

  if v_old_email is null then
    raise exception 'customer not found' using errcode = '22023';
  end if;

  if v_new_email = '' or v_new_email not like '%_@_%.__%' then
    raise exception 'new email must be a valid email address' using errcode = '22023';
  end if;

  if v_new_email = v_old_email then
    raise exception 'new email is the same as the current email' using errcode = '22023';
  end if;

  select id into v_collision
  from aa_02_crm.customers
  where lower(trim(email)) = v_new_email
    and id <> p_customer_id
  limit 1;

  v_counts := jsonb_build_object(
    'raw_orders',
      (select count(*) from aa_01_campaigns.raw_orders          where lower(trim(email))          = v_old_email),
    'historic_orders',
      (select count(*) from aa_01_campaigns.historic_orders     where lower(trim(email))          = v_old_email),
    'order_entitlements',
      (select count(*) from aa_01_campaigns.order_entitlements  where lower(trim(email))          = v_old_email),
    'payhere_payments',
      (select count(*) from aa_01_campaigns.payhere_payments    where lower(trim(customer_email)) = v_old_email),
    'manual_shipping_marks',
      (select count(*) from aa_01_campaigns.manual_shipping_marks where lower(trim(email))        = v_old_email),
    'acutrack_received',
      (select count(*) from aa_01_campaigns.acutrack_received   where lower(trim(email))          = v_old_email),
    'backer_fulfillment',
      (select count(*) from aa_01_campaigns.backer_fulfillment  where lower(trim(email))          = v_old_email),
    'tickets_linked_by_customer_id',
      (select count(*) from aa_02_crm.tickets                    where customer_id = p_customer_id),
    'tickets_by_requester_email_untouched',
      (select count(*) from aa_02_crm.tickets                    where lower(trim(requester_email)) = v_old_email)
  );

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'old_email',   v_old_email,
    'new_email',   v_new_email,
    'collision',   v_collision is not null,
    'collision_customer_id', v_collision,
    'counts',      v_counts
  );
end
$$;

grant execute on function public.preview_customer_email_change(bigint, text) to authenticated;

-- The write. Owner+admin only, single transaction.
create or replace function public.admin_change_customer_email(
  p_customer_id bigint,
  p_new_email   text,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, aa_01_campaigns, aa_02_crm
as $$
declare
  v_actor_uid  uuid := auth.uid();
  v_actor_email text;
  v_old_email  text;
  v_new_email  text := lower(trim(coalesce(p_new_email, '')));
  v_collision  bigint;
  v_counts     jsonb := '{}'::jsonb;
  v_n          int;
begin
  -- Owner + admin gate. Owner is Martin's auth.users.email; admin is
  -- our app_user_roles role. Both required.
  select lower(email) into v_actor_email from auth.users where id = v_actor_uid;
  if v_actor_email is null then
    raise exception 'forbidden: not signed in' using errcode = '42501';
  end if;
  if v_actor_email <> 'martinpstewart@gmail.com' then
    raise exception 'forbidden: owner only' using errcode = '42501';
  end if;
  if public.current_app_role() <> 'admin' then
    raise exception 'forbidden: admin role required' using errcode = '42501';
  end if;

  -- Lock the source customer row so a concurrent edit can't race us.
  select lower(trim(email)) into v_old_email
  from aa_02_crm.customers where id = p_customer_id for update;

  if v_old_email is null then
    raise exception 'customer not found' using errcode = '22023';
  end if;

  if v_new_email = '' or v_new_email not like '%_@_%.__%' then
    raise exception 'new email must be a valid email address' using errcode = '22023';
  end if;

  if v_new_email = v_old_email then
    raise exception 'new email is the same as the current email' using errcode = '22023';
  end if;

  select id into v_collision
  from aa_02_crm.customers
  where lower(trim(email)) = v_new_email
    and id <> p_customer_id
  limit 1;

  if v_collision is not null then
    raise exception 'new email already belongs to customer %', v_collision using errcode = '23505';
  end if;

  -- Move email across the 8 satellite tables.
  update aa_01_campaigns.raw_orders
     set email = v_new_email
   where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('raw_orders', v_n);

  update aa_01_campaigns.historic_orders
     set email = v_new_email
   where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('historic_orders', v_n);

  update aa_01_campaigns.order_entitlements
     set email = v_new_email
   where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('order_entitlements', v_n);

  update aa_01_campaigns.payhere_payments
     set customer_email = v_new_email
   where lower(trim(customer_email)) = v_old_email;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payhere_payments', v_n);

  update aa_01_campaigns.manual_shipping_marks
     set email = v_new_email
   where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('manual_shipping_marks', v_n);

  update aa_01_campaigns.acutrack_received
     set email = v_new_email
   where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('acutrack_received', v_n);

  update aa_01_campaigns.backer_fulfillment
     set email = v_new_email
   where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('backer_fulfillment', v_n);

  -- tickets.requester_email deliberately NOT updated (Freshdesk source
  -- of truth). Record the count for the audit trail.
  select count(*) into v_n
  from aa_02_crm.tickets
  where lower(trim(requester_email)) = v_old_email;
  v_counts := v_counts || jsonb_build_object('tickets_requester_email_left_untouched', v_n);

  -- Finally the canonical row.
  update aa_02_crm.customers
     set email = v_new_email,
         updated_at = now()
   where id = p_customer_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customers', v_n);

  -- Audit.
  insert into aa_02_crm.customer_email_change_log
    (customer_id, old_email, new_email, changed_by, counts, note)
  values
    (p_customer_id, v_old_email, v_new_email, v_actor_uid, v_counts, p_note);

  -- Post-write refresh of the two snapshots that back the customer +
  -- campaign screens. Both refresh helpers are argument-less and
  -- self-throttled by their internal watermark, so calling them is
  -- cheap. Non-fatal on failure — the hourly cron will catch up.
  begin
    perform aa_02_crm.refresh_customer_list_snapshot_incremental();
  exception when others then
    null;
  end;

  begin
    perform aa_02_crm.refresh_campaign_backers_snapshot_incremental();
  exception when others then
    null;
  end;

  -- mv_raw_order_line_attribution + mv_contact_campaign_engagement +
  -- campaign_orders_snapshot refresh on their normal cron. They feed
  -- segment / attribution / campaign-orders-tab surfaces, not the
  -- customer detail page.

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'old_email',   v_old_email,
    'new_email',   v_new_email,
    'counts',      v_counts
  );
end
$$;

grant execute on function public.admin_change_customer_email(bigint, text, text) to authenticated;
