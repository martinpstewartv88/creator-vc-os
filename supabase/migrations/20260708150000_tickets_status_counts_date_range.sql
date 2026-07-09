-- Extend tickets_status_counts with optional date-range filter.
--
-- Reiner reported the tab badges on /tickets don't change when he
-- picks a new date range — they always show the last-30-day counts.
-- The RPC was written to intentionally stay all-time; we now want
-- them to reflect the current window (same as tickets_list) so the
-- badge counts match the visible list.
--
-- Additive change: both new params default to NULL, and NULL means
-- "no filter" (same as today). Existing callers passing zero args
-- keep working unchanged.
--
-- Uses `created_at` — same column tickets_list and
-- get_tickets_summary_stats use for their p_from/p_to windows. Half-
-- open interval [p_from, p_to) to match those RPCs.

create or replace function public.tickets_status_counts(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'aa_04_support'
as $function$
declare v_out jsonb;
begin
  if public.current_app_role() is null then
    raise exception 'forbidden: staff only';
  end if;
  -- Single scan, bucket by status. Status values are the Freshdesk
  -- vocabulary (Open / Pending / Resolved / Closed). Anything else
  -- (shouldn't happen) is silently grouped into 'other' for safety.
  -- Date window is optional; when both bounds are null, behaviour is
  -- identical to the pre-2026-07-08 all-time form.
  select jsonb_build_object(
    'all',      count(*),
    'Open',     count(*) filter (where status = 'Open'),
    'Pending',  count(*) filter (where status = 'Pending'),
    'Resolved', count(*) filter (where status = 'Resolved'),
    'Closed',   count(*) filter (where status = 'Closed'),
    'other',    count(*) filter (where status not in ('Open','Pending','Resolved','Closed'))
  )
  into v_out
  from aa_04_support.tickets
  where (p_from is null or created_at >= p_from)
    and (p_to   is null or created_at <  p_to);
  return v_out;
end;
$function$;
