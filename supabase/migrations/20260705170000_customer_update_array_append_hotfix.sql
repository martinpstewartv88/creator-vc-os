-- Hotfix: customer_update raises "malformed array literal" when the
-- operator actually edits a field.
--
-- Cause: the ledger diff loop appends field names with
--   v_changed_fields := v_changed_fields || 'shipping_address_1';
-- The right-hand side is an untyped string literal; Postgres resolves
-- the operator by inference and picks the text[] || text[] overload,
-- then tries to parse 'shipping_address_1' as an array literal, which
-- fails with 22P02.
--
-- Swap every append to array_append(v_changed_fields, '...') so the
-- overload is unambiguous. Function body is otherwise identical to
-- 20260705120000_customer_profile_change_log.

create or replace function public.customer_update(
  p_customer_id        bigint,
  p_first_name         text,
  p_last_name          text,
  p_phone              text,
  p_shipping_address_1 text,
  p_shipping_address_2 text,
  p_shipping_city      text,
  p_shipping_zip       text,
  p_shipping_country   text
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'aa_02_crm'
as $$
declare
  v_first text := nullif(trim(coalesce(p_first_name, '')), '');
  v_last  text := nullif(trim(coalesce(p_last_name, '')), '');
  v_phone text := nullif(trim(coalesce(p_phone, '')), '');
  v_ad1   text := nullif(trim(coalesce(p_shipping_address_1, '')), '');
  v_ad2   text := nullif(trim(coalesce(p_shipping_address_2, '')), '');
  v_city  text := nullif(trim(coalesce(p_shipping_city, '')), '');
  v_zip   text := nullif(trim(coalesce(p_shipping_zip, '')), '');
  v_ctry  text := nullif(trim(coalesce(p_shipping_country, '')), '');

  v_before  aa_02_crm.customers%rowtype;
  v_before_json jsonb;
  v_after_json  jsonb;
  v_changed_fields text[] := '{}';
begin
  if public.current_app_role() is null then
    raise exception 'forbidden: staff only';
  end if;

  select * into v_before from aa_02_crm.customers
   where id = p_customer_id
   for update;

  if v_before.id is null then
    raise exception 'customer not found' using errcode = '22023';
  end if;

  v_before_json := jsonb_build_object(
    'first_name',         v_before.first_name,
    'last_name',          v_before.last_name,
    'phone',              v_before.phone,
    'shipping_address_1', v_before.shipping_address_1,
    'shipping_address_2', v_before.shipping_address_2,
    'shipping_city',      v_before.shipping_city,
    'shipping_zip',       v_before.shipping_zip,
    'shipping_country',   v_before.shipping_country,
    'shipping_country_code', v_before.shipping_country_code
  );

  v_after_json := jsonb_build_object(
    'first_name',         v_first,
    'last_name',          v_last,
    'phone',              v_phone,
    'shipping_address_1', v_ad1,
    'shipping_address_2', v_ad2,
    'shipping_city',      v_city,
    'shipping_zip',       v_zip,
    'shipping_country',   v_ctry,
    'shipping_country_code', case when v_before.shipping_country is distinct from v_ctry
                                  then null
                                  else v_before.shipping_country_code end
  );

  if v_before.first_name         is distinct from v_first then v_changed_fields := array_append(v_changed_fields, 'first_name'); end if;
  if v_before.last_name          is distinct from v_last  then v_changed_fields := array_append(v_changed_fields, 'last_name');  end if;
  if v_before.phone              is distinct from v_phone then v_changed_fields := array_append(v_changed_fields, 'phone');      end if;
  if v_before.shipping_address_1 is distinct from v_ad1   then v_changed_fields := array_append(v_changed_fields, 'shipping_address_1'); end if;
  if v_before.shipping_address_2 is distinct from v_ad2   then v_changed_fields := array_append(v_changed_fields, 'shipping_address_2'); end if;
  if v_before.shipping_city      is distinct from v_city  then v_changed_fields := array_append(v_changed_fields, 'shipping_city'); end if;
  if v_before.shipping_zip       is distinct from v_zip   then v_changed_fields := array_append(v_changed_fields, 'shipping_zip');  end if;
  if v_before.shipping_country   is distinct from v_ctry  then v_changed_fields := array_append(v_changed_fields, 'shipping_country'); end if;

  if array_length(v_changed_fields, 1) is null then
    return;
  end if;

  update aa_02_crm.customers
     set first_name         = v_first,
         last_name          = v_last,
         phone              = v_phone,
         shipping_address_1 = v_ad1,
         shipping_address_2 = v_ad2,
         shipping_city      = v_city,
         shipping_zip       = v_zip,
         shipping_country   = v_ctry,
         shipping_country_code = case
           when shipping_country is distinct from v_ctry then null
           else shipping_country_code
         end,
         updated_at         = now()
   where id = p_customer_id;

  insert into aa_02_crm.customer_profile_change_log
    (customer_id, changed_by, before, after, changed_fields, email_snapshot)
  values
    (p_customer_id, auth.uid(), v_before_json, v_after_json, v_changed_fields, v_before.email);
end;
$$;
