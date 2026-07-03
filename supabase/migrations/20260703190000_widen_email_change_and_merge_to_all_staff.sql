-- Widen email-change + merge RPC gates: admin+support → any staff role.
--
-- Team role now included alongside admin + support. All three staff
-- roles can edit customer records elsewhere in the app; consolidating
-- accounts is part of the same set of chores. Audit table still
-- records auth.uid() for every change, so accountability is preserved.
--
-- Only the gate line changes; the transactional body is identical to
-- 20260703180000_widen_email_change_and_merge_to_admin_support. Do not
-- overwrite the satellite-table UPDATE list without preserving both.

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
  v_old_email  text;
  v_new_email  text := lower(trim(coalesce(p_new_email, '')));
  v_collision  bigint;
  v_counts     jsonb := '{}'::jsonb;
  v_n          int;
begin
  if v_actor_uid is null then
    raise exception 'forbidden: not signed in' using errcode = '42501';
  end if;
  if public.current_app_role() not in ('admin','team','support') then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;

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

  update aa_01_campaigns.raw_orders           set email = v_new_email where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('raw_orders', v_n);
  update aa_01_campaigns.historic_orders      set email = v_new_email where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('historic_orders', v_n);
  update aa_01_campaigns.order_entitlements   set email = v_new_email where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('order_entitlements', v_n);
  update aa_01_campaigns.payhere_payments     set customer_email = v_new_email where lower(trim(customer_email)) = v_old_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('payhere_payments', v_n);
  update aa_01_campaigns.manual_shipping_marks set email = v_new_email where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('manual_shipping_marks', v_n);
  update aa_01_campaigns.acutrack_received    set email = v_new_email where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('acutrack_received', v_n);
  update aa_01_campaigns.backer_fulfillment   set email = v_new_email where lower(trim(email)) = v_old_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('backer_fulfillment', v_n);

  select count(*) into v_n from aa_02_crm.tickets where lower(trim(requester_email)) = v_old_email;
  v_counts := v_counts || jsonb_build_object('tickets_requester_email_left_untouched', v_n);

  update aa_02_crm.customers set email = v_new_email, updated_at = now() where id = p_customer_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('customers', v_n);

  insert into aa_02_crm.customer_email_change_log (customer_id, old_email, new_email, changed_by, counts, note)
  values (p_customer_id, v_old_email, v_new_email, v_actor_uid, v_counts, p_note);

  begin perform aa_02_crm.refresh_customer_list_snapshot_incremental(); exception when others then null; end;
  begin perform aa_02_crm.refresh_campaign_backers_snapshot_incremental(); exception when others then null; end;

  return jsonb_build_object('customer_id', p_customer_id, 'old_email', v_old_email, 'new_email', v_new_email, 'counts', v_counts);
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
set search_path = pg_catalog, public, aa_01_campaigns, aa_02_crm
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

  update aa_01_campaigns.raw_orders           set email = v_survivor_email where lower(trim(email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('raw_orders', v_n);
  update aa_01_campaigns.historic_orders      set email = v_survivor_email where lower(trim(email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('historic_orders', v_n);
  update aa_01_campaigns.order_entitlements   set email = v_survivor_email where lower(trim(email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('order_entitlements', v_n);
  update aa_01_campaigns.payhere_payments     set customer_email = v_survivor_email where lower(trim(customer_email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('payhere_payments', v_n);
  update aa_01_campaigns.manual_shipping_marks set email = v_survivor_email where lower(trim(email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('manual_shipping_marks', v_n);
  update aa_01_campaigns.acutrack_received    set email = v_survivor_email where lower(trim(email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('acutrack_received', v_n);
  update aa_01_campaigns.backer_fulfillment   set email = v_survivor_email where lower(trim(email)) = v_merged_email;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('backer_fulfillment', v_n);

  delete from aa_02_crm.customer_raw_orders m
   where m.customer_id = p_merged_id
     and exists (select 1 from aa_02_crm.customer_raw_orders s where s.customer_id = p_survivor_id and s.raw_order_id = m.raw_order_id);
  update aa_02_crm.customer_raw_orders set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('junction_raw_orders_reparented', v_n);

  delete from aa_02_crm.customer_campaign_orders m
   where m.customer_id = p_merged_id
     and exists (select 1 from aa_02_crm.customer_campaign_orders s where s.customer_id = p_survivor_id and s.campaign_order_id = m.campaign_order_id);
  update aa_02_crm.customer_campaign_orders set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('junction_campaign_orders_reparented', v_n);

  update aa_02_crm.tickets set customer_id = p_survivor_id where customer_id = p_merged_id;
  get diagnostics v_n = row_count;  v_counts := v_counts || jsonb_build_object('tickets_customer_id_reparented', v_n);

  select count(*) into v_n from aa_02_crm.tickets where lower(trim(requester_email)) = v_merged_email;
  v_counts := v_counts || jsonb_build_object('tickets_requester_email_left_untouched', v_n);

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

  insert into aa_02_crm.customer_email_change_log (customer_id, old_email, new_email, changed_by, counts, note, merged_customer_id)
  values (p_survivor_id, v_merged_email, v_survivor_email, v_actor_uid, v_counts, p_note, p_merged_id);

  delete from aa_02_crm.customers where id = p_merged_id;

  begin perform aa_02_crm.refresh_customer_list_snapshot_changed(array[p_survivor_id, p_merged_id]); exception when others then null; end;
  begin perform aa_02_crm.refresh_campaign_backers_snapshot_incremental(); exception when others then null; end;

  return jsonb_build_object('survivor_customer_id', p_survivor_id, 'merged_customer_id', p_merged_id, 'survivor_email', v_survivor_email, 'merged_email', v_merged_email, 'counts', v_counts);
end
$$;
