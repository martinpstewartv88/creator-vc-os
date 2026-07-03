-- Customer merge — cascade two customer records into one.
--
-- This is the collision-case sibling of admin_change_customer_email. When
-- an operator tries to change customer A's email to one that already
-- belongs to customer B, the correct action is to consolidate A into B:
-- move all of A's orders / entitlements / payhere / fulfilment rows onto
-- B, re-point the two junction tables' customer_id from A's id to B's id,
-- back-fill any NULL contact/shipping fields on B from A, then DELETE A's
-- customer row.
--
-- The rename RPC already refuses on collision. This adds:
--   1. customer_email_change_log gets a nullable merged_customer_id
--      column. NULL means the row records a rename; populated means a
--      merge (old_email = the merged/dead customer's email).
--   2. public.preview_customer_merge(survivor_id, merged_id) — read-only,
--      returns both customers' fields, per-table counts, and the list of
--      fields that would be back-filled on the survivor.
--   3. public.admin_merge_customers(survivor_id, merged_id, note) —
--      owner+admin, single transaction, does the moves + backfill +
--      audit + DELETE + snapshot refresh.
--
-- Freshdesk: same rule as the rename RPC. tickets.customer_id gets
-- re-pointed from merged → survivor (that's how the /customers/[email]
-- ticket list finds them). tickets.requester_email is left as whatever
-- Freshdesk knows. Audit log records the count untouched.
--
-- Junctions: aa_02_crm.customer_raw_orders and customer_campaign_orders
-- both have UNIQUE(customer_id, order_id). A naïve UPDATE that maps
-- merged_id → survivor_id would violate the constraint if both customers
-- happened to link to the same order (shouldn't happen — one order has
-- one email — but defensively: we DELETE the merged-side row first when
-- a same-order duplicate exists, then UPDATE).
--
-- Snapshots: refresh_customer_list_snapshot_changed handles the delete
-- path natively (it clears rows whose customer no longer exists), so
-- calling it with array[survivor_id, merged_id] both refreshes the
-- survivor's row and evicts the merged customer's stale snapshot row.
-- For backers, we call the incremental refresh; cron will catch stragglers.

alter table aa_02_crm.customer_email_change_log
  add column if not exists merged_customer_id bigint;

comment on column aa_02_crm.customer_email_change_log.merged_customer_id is
  'NULL for a rename event; set to the dead customer''s id for a merge event.';

-- Read-only preview.
create or replace function public.preview_customer_merge(
  p_survivor_id bigint,
  p_merged_id   bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, aa_01_campaigns, aa_02_crm
as $$
declare
  v_survivor jsonb;
  v_merged   jsonb;
  v_backfill text[] := '{}';
  v_counts   jsonb;
begin
  if public.current_app_role() is null then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;

  if p_survivor_id = p_merged_id then
    raise exception 'survivor and merged customer are the same' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'id', id, 'email', email, 'first_name', first_name, 'last_name', last_name,
    'phone', phone, 'shipping_address_1', shipping_address_1,
    'shipping_address_2', shipping_address_2, 'shipping_city', shipping_city,
    'shipping_zip', shipping_zip, 'shipping_country', shipping_country
  )
  into v_survivor
  from aa_02_crm.customers where id = p_survivor_id;

  select jsonb_build_object(
    'id', id, 'email', email, 'first_name', first_name, 'last_name', last_name,
    'phone', phone, 'shipping_address_1', shipping_address_1,
    'shipping_address_2', shipping_address_2, 'shipping_city', shipping_city,
    'shipping_zip', shipping_zip, 'shipping_country', shipping_country
  )
  into v_merged
  from aa_02_crm.customers where id = p_merged_id;

  if v_survivor is null then raise exception 'survivor customer not found' using errcode = '22023'; end if;
  if v_merged   is null then raise exception 'merged customer not found'   using errcode = '22023'; end if;

  -- Back-fill preview (rule A: survivor wins on populated fields; only NULLs get filled from merged).
  if v_survivor->>'first_name'         is null and v_merged->>'first_name'         is not null then v_backfill := v_backfill || 'first_name'; end if;
  if v_survivor->>'last_name'          is null and v_merged->>'last_name'          is not null then v_backfill := v_backfill || 'last_name'; end if;
  if v_survivor->>'phone'              is null and v_merged->>'phone'              is not null then v_backfill := v_backfill || 'phone'; end if;
  if v_survivor->>'shipping_address_1' is null and v_merged->>'shipping_address_1' is not null then v_backfill := v_backfill || 'shipping_address_1'; end if;
  if v_survivor->>'shipping_address_2' is null and v_merged->>'shipping_address_2' is not null then v_backfill := v_backfill || 'shipping_address_2'; end if;
  if v_survivor->>'shipping_city'      is null and v_merged->>'shipping_city'      is not null then v_backfill := v_backfill || 'shipping_city'; end if;
  if v_survivor->>'shipping_zip'       is null and v_merged->>'shipping_zip'       is not null then v_backfill := v_backfill || 'shipping_zip'; end if;
  if v_survivor->>'shipping_country'   is null and v_merged->>'shipping_country'   is not null then v_backfill := v_backfill || 'shipping_country'; end if;

  v_counts := jsonb_build_object(
    'raw_orders',
      (select count(*) from aa_01_campaigns.raw_orders          where lower(trim(email))          = lower(v_merged->>'email')),
    'historic_orders',
      (select count(*) from aa_01_campaigns.historic_orders     where lower(trim(email))          = lower(v_merged->>'email')),
    'order_entitlements',
      (select count(*) from aa_01_campaigns.order_entitlements  where lower(trim(email))          = lower(v_merged->>'email')),
    'payhere_payments',
      (select count(*) from aa_01_campaigns.payhere_payments    where lower(trim(customer_email)) = lower(v_merged->>'email')),
    'manual_shipping_marks',
      (select count(*) from aa_01_campaigns.manual_shipping_marks where lower(trim(email))        = lower(v_merged->>'email')),
    'acutrack_received',
      (select count(*) from aa_01_campaigns.acutrack_received   where lower(trim(email))          = lower(v_merged->>'email')),
    'backer_fulfillment',
      (select count(*) from aa_01_campaigns.backer_fulfillment  where lower(trim(email))          = lower(v_merged->>'email')),
    'junction_raw_orders',
      (select count(*) from aa_02_crm.customer_raw_orders       where customer_id = p_merged_id),
    'junction_campaign_orders',
      (select count(*) from aa_02_crm.customer_campaign_orders  where customer_id = p_merged_id),
    'tickets_by_customer_id',
      (select count(*) from aa_02_crm.tickets                    where customer_id = p_merged_id),
    'tickets_requester_email_left_untouched',
      (select count(*) from aa_02_crm.tickets                    where lower(trim(requester_email)) = lower(v_merged->>'email'))
  );

  return jsonb_build_object(
    'survivor', v_survivor,
    'merged',   v_merged,
    'backfill_fields', to_jsonb(v_backfill),
    'counts',   v_counts
  );
end
$$;

grant execute on function public.preview_customer_merge(bigint, bigint) to authenticated;

-- The write.
create or replace function public.admin_merge_customers(
  p_survivor_id bigint,
  p_merged_id   bigint,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, aa_01_campaigns, aa_02_crm
as $$
declare
  v_actor_uid   uuid := auth.uid();
  v_actor_email text;
  v_lock_first  bigint;
  v_lock_second bigint;
  v_survivor_email text;
  v_merged_email   text;
  v_survivor  aa_02_crm.customers%rowtype;
  v_merged    aa_02_crm.customers%rowtype;
  v_counts    jsonb := '{}'::jsonb;
  v_backfilled text[] := '{}';
  v_n int;
begin
  -- Gate: owner (Martin) AND admin role.
  select lower(email) into v_actor_email from auth.users where id = v_actor_uid;
  if v_actor_email is null                            then raise exception 'forbidden: not signed in'      using errcode = '42501'; end if;
  if v_actor_email <> 'martinpstewart@gmail.com'      then raise exception 'forbidden: owner only'         using errcode = '42501'; end if;
  if public.current_app_role() <> 'admin'             then raise exception 'forbidden: admin role required' using errcode = '42501'; end if;

  if p_survivor_id = p_merged_id then
    raise exception 'survivor and merged customer are the same' using errcode = '22023';
  end if;

  -- Lock in ID order to avoid two concurrent merges deadlocking each other.
  v_lock_first  := least(p_survivor_id, p_merged_id);
  v_lock_second := greatest(p_survivor_id, p_merged_id);
  perform 1 from aa_02_crm.customers where id = v_lock_first  for update;
  perform 1 from aa_02_crm.customers where id = v_lock_second for update;

  select * into v_survivor from aa_02_crm.customers where id = p_survivor_id;
  select * into v_merged   from aa_02_crm.customers where id = p_merged_id;

  if v_survivor.id is null then raise exception 'survivor customer not found' using errcode = '22023'; end if;
  if v_merged.id   is null then raise exception 'merged customer not found'   using errcode = '22023'; end if;

  v_survivor_email := lower(trim(v_survivor.email));
  v_merged_email   := lower(trim(v_merged.email));

  if v_survivor_email = v_merged_email then
    raise exception 'both customers already have the same email — nothing to merge' using errcode = '22023';
  end if;

  -- Move email across the 8 satellite tables.
  update aa_01_campaigns.raw_orders           set email          = v_survivor_email where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('raw_orders', v_n);

  update aa_01_campaigns.historic_orders      set email          = v_survivor_email where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('historic_orders', v_n);

  update aa_01_campaigns.order_entitlements   set email          = v_survivor_email where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('order_entitlements', v_n);

  update aa_01_campaigns.payhere_payments     set customer_email = v_survivor_email where lower(trim(customer_email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('payhere_payments', v_n);

  update aa_01_campaigns.manual_shipping_marks set email         = v_survivor_email where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('manual_shipping_marks', v_n);

  update aa_01_campaigns.acutrack_received    set email          = v_survivor_email where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('acutrack_received', v_n);

  update aa_01_campaigns.backer_fulfillment   set email          = v_survivor_email where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('backer_fulfillment', v_n);

  -- Junctions: delete conflict rows on the merged side first, then re-parent.
  delete from aa_02_crm.customer_raw_orders m
   where m.customer_id = p_merged_id
     and exists (
       select 1 from aa_02_crm.customer_raw_orders s
       where s.customer_id = p_survivor_id
         and s.raw_order_id = m.raw_order_id
     );
  update aa_02_crm.customer_raw_orders set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('junction_raw_orders_reparented', v_n);

  delete from aa_02_crm.customer_campaign_orders m
   where m.customer_id = p_merged_id
     and exists (
       select 1 from aa_02_crm.customer_campaign_orders s
       where s.customer_id = p_survivor_id
         and s.campaign_order_id = m.campaign_order_id
     );
  update aa_02_crm.customer_campaign_orders set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('junction_campaign_orders_reparented', v_n);

  -- Tickets: re-point customer_id only. requester_email untouched (Freshdesk = source of truth).
  update aa_02_crm.tickets set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('tickets_customer_id_reparented', v_n);

  select count(*) into v_n from aa_02_crm.tickets where lower(trim(requester_email)) = v_merged_email;
  v_counts := v_counts || jsonb_build_object('tickets_requester_email_left_untouched', v_n);

  -- Back-fill: survivor wins on populated fields; only NULLs get filled from merged.
  update aa_02_crm.customers s
     set first_name         = coalesce(s.first_name,         v_merged.first_name),
         last_name          = coalesce(s.last_name,          v_merged.last_name),
         phone              = coalesce(s.phone,              v_merged.phone),
         shipping_address_1 = coalesce(s.shipping_address_1, v_merged.shipping_address_1),
         shipping_address_2 = coalesce(s.shipping_address_2, v_merged.shipping_address_2),
         shipping_city      = coalesce(s.shipping_city,      v_merged.shipping_city),
         shipping_zip       = coalesce(s.shipping_zip,       v_merged.shipping_zip),
         shipping_country   = coalesce(s.shipping_country,   v_merged.shipping_country),
         shipping_country_code = coalesce(s.shipping_country_code, v_merged.shipping_country_code),
         updated_at         = now()
   where s.id = p_survivor_id;

  if v_survivor.first_name         is null and v_merged.first_name         is not null then v_backfilled := v_backfilled || 'first_name'; end if;
  if v_survivor.last_name          is null and v_merged.last_name          is not null then v_backfilled := v_backfilled || 'last_name'; end if;
  if v_survivor.phone              is null and v_merged.phone              is not null then v_backfilled := v_backfilled || 'phone'; end if;
  if v_survivor.shipping_address_1 is null and v_merged.shipping_address_1 is not null then v_backfilled := v_backfilled || 'shipping_address_1'; end if;
  if v_survivor.shipping_address_2 is null and v_merged.shipping_address_2 is not null then v_backfilled := v_backfilled || 'shipping_address_2'; end if;
  if v_survivor.shipping_city      is null and v_merged.shipping_city      is not null then v_backfilled := v_backfilled || 'shipping_city'; end if;
  if v_survivor.shipping_zip       is null and v_merged.shipping_zip       is not null then v_backfilled := v_backfilled || 'shipping_zip'; end if;
  if v_survivor.shipping_country   is null and v_merged.shipping_country   is not null then v_backfilled := v_backfilled || 'shipping_country'; end if;

  v_counts := v_counts || jsonb_build_object('backfilled_fields', to_jsonb(v_backfilled));

  -- Audit.
  insert into aa_02_crm.customer_email_change_log
    (customer_id, old_email, new_email, changed_by, counts, note, merged_customer_id)
  values
    (p_survivor_id, v_merged_email, v_survivor_email, v_actor_uid, v_counts, p_note, p_merged_id);

  -- Delete the merged customer row now that nothing references it.
  delete from aa_02_crm.customers where id = p_merged_id;

  -- Snapshot refresh: the customer-list snapshot's changed-variant handles
  -- both an update (survivor) and a deletion (merged) in one call.
  begin
    perform aa_02_crm.refresh_customer_list_snapshot_changed(
      array[p_survivor_id, p_merged_id]
    );
  exception when others then
    null;
  end;

  -- Backers snapshot: no changed-variant; fire the incremental so the
  -- survivor's row picks up its new orders.
  begin
    perform aa_02_crm.refresh_campaign_backers_snapshot_incremental();
  exception when others then
    null;
  end;

  return jsonb_build_object(
    'survivor_customer_id', p_survivor_id,
    'merged_customer_id',   p_merged_id,
    'survivor_email',       v_survivor_email,
    'merged_email',         v_merged_email,
    'counts',               v_counts
  );
end
$$;

grant execute on function public.admin_merge_customers(bigint, bigint, text) to authenticated;
