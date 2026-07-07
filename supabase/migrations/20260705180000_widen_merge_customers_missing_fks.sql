-- Hotfix: admin_merge_customers was missing 4 FKs pointing at
-- aa_02_crm.customers.id, so the final DELETE step blew up on any
-- merged customer that had a row in one of them.
--
-- Reiner hit it merging jon147@aol.com → jonathan.zeledon@gmail.com:
-- jon147 had a row in aa_04_support.tickets which we didn't re-point,
-- so the delete tripped tickets_customer_id_fkey.
--
-- All 7 FKs to customers.id, and how the RPC now handles each:
--   aa_02_crm.customer_raw_orders            re-parent (already handled)
--   aa_02_crm.customer_campaign_orders       re-parent (already handled)
--   aa_02_crm.customer_historic_orders       re-parent (NEW)
--   aa_02_crm.tickets                        re-parent (already handled)
--   aa_03_marketing.contacts                 re-parent (NEW)
--   aa_04_support.tickets                    re-parent (NEW)
--   public._archive_customer_isod_orders     re-parent (NEW, defensive)
--
-- Junction conflict pattern: customer_historic_orders has
-- UNIQUE(customer_id, historic_order_id), same as the two junctions we
-- already handle — so we delete conflicting merged-side rows first,
-- then update the rest.
--
-- Non-junction tables: contacts is keyed UNIQUE on email (not
-- customer_id) so we can straight-update customer_id; a customer can
-- validly have multiple contact rows. aa_04_support.tickets has no
-- unique on customer_id at all. The archive table is defensive — zero
-- rows in prod today but no harm in the update.
--
-- Preview grows to report the new row counts so operators aren't
-- surprised at commit time.

create or replace function public.preview_customer_merge(
  p_survivor_id bigint,
  p_merged_id   bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, aa_01_campaigns, aa_02_crm, aa_03_marketing, aa_04_support
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

  if v_survivor->>'first_name'         is null and v_merged->>'first_name'         is not null then v_backfill := array_append(v_backfill, 'first_name'); end if;
  if v_survivor->>'last_name'          is null and v_merged->>'last_name'          is not null then v_backfill := array_append(v_backfill, 'last_name'); end if;
  if v_survivor->>'phone'              is null and v_merged->>'phone'              is not null then v_backfill := array_append(v_backfill, 'phone'); end if;
  if v_survivor->>'shipping_address_1' is null and v_merged->>'shipping_address_1' is not null then v_backfill := array_append(v_backfill, 'shipping_address_1'); end if;
  if v_survivor->>'shipping_address_2' is null and v_merged->>'shipping_address_2' is not null then v_backfill := array_append(v_backfill, 'shipping_address_2'); end if;
  if v_survivor->>'shipping_city'      is null and v_merged->>'shipping_city'      is not null then v_backfill := array_append(v_backfill, 'shipping_city'); end if;
  if v_survivor->>'shipping_zip'       is null and v_merged->>'shipping_zip'       is not null then v_backfill := array_append(v_backfill, 'shipping_zip'); end if;
  if v_survivor->>'shipping_country'   is null and v_merged->>'shipping_country'   is not null then v_backfill := array_append(v_backfill, 'shipping_country'); end if;

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
    'junction_historic_orders',
      (select count(*) from aa_02_crm.customer_historic_orders  where customer_id = p_merged_id),
    'tickets_by_customer_id',
      (select count(*) from aa_02_crm.tickets                    where customer_id = p_merged_id),
    'tickets_by_customer_id_support',
      (select count(*) from aa_04_support.tickets                where customer_id = p_merged_id),
    'contacts',
      (select count(*) from aa_03_marketing.contacts             where customer_id = p_merged_id),
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

create or replace function public.admin_merge_customers(
  p_survivor_id bigint,
  p_merged_id   bigint,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, aa_01_campaigns, aa_02_crm, aa_03_marketing, aa_04_support
as $$
declare
  v_actor_uid   uuid := auth.uid();
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
  if v_actor_uid is null then
    raise exception 'forbidden: not signed in' using errcode = '42501';
  end if;
  if public.current_app_role() not in ('admin','team','support') then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;

  if p_survivor_id = p_merged_id then
    raise exception 'survivor and merged customer are the same' using errcode = '22023';
  end if;

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

  -- Satellite email tables (unchanged).
  update aa_01_campaigns.raw_orders            set email = v_survivor_email          where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('raw_orders', v_n);
  update aa_01_campaigns.historic_orders       set email = v_survivor_email          where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('historic_orders', v_n);
  update aa_01_campaigns.order_entitlements    set email = v_survivor_email          where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('order_entitlements', v_n);
  update aa_01_campaigns.payhere_payments      set customer_email = v_survivor_email where lower(trim(customer_email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('payhere_payments', v_n);
  update aa_01_campaigns.manual_shipping_marks set email = v_survivor_email          where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('manual_shipping_marks', v_n);
  update aa_01_campaigns.acutrack_received     set email = v_survivor_email          where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('acutrack_received', v_n);
  update aa_01_campaigns.backer_fulfillment    set email = v_survivor_email          where lower(trim(email))          = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('backer_fulfillment', v_n);

  -- Junctions (delete-conflicts-then-update pattern). customer_historic_orders
  -- has the same UNIQUE(customer_id, historic_order_id) shape as the other two.
  delete from aa_02_crm.customer_raw_orders m
   where m.customer_id = p_merged_id
     and exists (select 1 from aa_02_crm.customer_raw_orders s
                  where s.customer_id = p_survivor_id and s.raw_order_id = m.raw_order_id);
  update aa_02_crm.customer_raw_orders set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('junction_raw_orders_reparented', v_n);

  delete from aa_02_crm.customer_campaign_orders m
   where m.customer_id = p_merged_id
     and exists (select 1 from aa_02_crm.customer_campaign_orders s
                  where s.customer_id = p_survivor_id and s.campaign_order_id = m.campaign_order_id);
  update aa_02_crm.customer_campaign_orders set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('junction_campaign_orders_reparented', v_n);

  delete from aa_02_crm.customer_historic_orders m
   where m.customer_id = p_merged_id
     and exists (select 1 from aa_02_crm.customer_historic_orders s
                  where s.customer_id = p_survivor_id and s.historic_order_id = m.historic_order_id);
  update aa_02_crm.customer_historic_orders set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('junction_historic_orders_reparented', v_n);

  -- Tickets (both schemas). requester_email untouched (Freshdesk = source of truth).
  update aa_02_crm.tickets     set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('tickets_customer_id_reparented', v_n);
  update aa_04_support.tickets set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('tickets_support_customer_id_reparented', v_n);

  select count(*) into v_n from aa_02_crm.tickets where lower(trim(requester_email)) = v_merged_email;
  v_counts := v_counts || jsonb_build_object('tickets_requester_email_left_untouched', v_n);

  -- Marketing contacts. UNIQUE is on email only, so a straight
  -- customer_id update is safe (multiple contact rows can share a
  -- customer_id). We keep the merged customer's old contact row
  -- pointing at the survivor customer so historical marketing consent
  -- is preserved.
  update aa_03_marketing.contacts set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('contacts_reparented', v_n);

  -- Archive table (defensive — zero rows expected in prod today).
  update public._archive_customer_isod_orders set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('archive_isod_reparented', v_n);

  -- Back-fill (unchanged).
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

  if v_survivor.first_name         is null and v_merged.first_name         is not null then v_backfilled := array_append(v_backfilled, 'first_name'); end if;
  if v_survivor.last_name          is null and v_merged.last_name          is not null then v_backfilled := array_append(v_backfilled, 'last_name'); end if;
  if v_survivor.phone              is null and v_merged.phone              is not null then v_backfilled := array_append(v_backfilled, 'phone'); end if;
  if v_survivor.shipping_address_1 is null and v_merged.shipping_address_1 is not null then v_backfilled := array_append(v_backfilled, 'shipping_address_1'); end if;
  if v_survivor.shipping_address_2 is null and v_merged.shipping_address_2 is not null then v_backfilled := array_append(v_backfilled, 'shipping_address_2'); end if;
  if v_survivor.shipping_city      is null and v_merged.shipping_city      is not null then v_backfilled := array_append(v_backfilled, 'shipping_city'); end if;
  if v_survivor.shipping_zip       is null and v_merged.shipping_zip       is not null then v_backfilled := array_append(v_backfilled, 'shipping_zip'); end if;
  if v_survivor.shipping_country   is null and v_merged.shipping_country   is not null then v_backfilled := array_append(v_backfilled, 'shipping_country'); end if;

  v_counts := v_counts || jsonb_build_object('backfilled_fields', to_jsonb(v_backfilled));

  insert into aa_02_crm.customer_email_change_log
    (customer_id, old_email, new_email, changed_by, counts, note, merged_customer_id)
  values
    (p_survivor_id, v_merged_email, v_survivor_email, v_actor_uid, v_counts, p_note, p_merged_id);

  delete from aa_02_crm.customers where id = p_merged_id;

  begin perform aa_02_crm.refresh_customer_list_snapshot_changed(array[p_survivor_id, p_merged_id]); exception when others then null; end;
  begin perform aa_02_crm.refresh_campaign_backers_snapshot_incremental(); exception when others then null; end;

  return jsonb_build_object(
    'survivor_customer_id', p_survivor_id,
    'merged_customer_id',   p_merged_id,
    'survivor_email',       v_survivor_email,
    'merged_email',         v_merged_email,
    'counts',               v_counts
  );
end
$$;
