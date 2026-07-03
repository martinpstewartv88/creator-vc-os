-- Audit table for outbound Acutrack "order created" pushes.
--
-- Every time a staff user clicks "Mark shipping paid" on a Shopify
-- order row, the frontend fires the acutrack-send-order edge function
-- (fire-and-forget). That function loads the raw_orders row, shapes
-- the payload to Acutrack's webhook schema, POSTs it, and inserts a
-- row here recording the attempt.
--
-- Keeps everything auditable: what we sent, what came back, who
-- triggered it, when. request_body/response_body stored raw so we
-- can replay from the log if Acutrack changes their schema or a
-- push has to be reissued.
--
-- No RLS grant to anon/authenticated — the edge function writes via
-- service_role. Staff-visible read comes later if we ever surface an
-- Acutrack push history in the UI.

create table if not exists aa_01_campaigns.acutrack_send_log (
  id                    bigint generated always as identity primary key,
  shopify_order_id      text not null,
  shopify_order_number  text,
  triggered_by          uuid,
  request_body          jsonb not null,
  response_status       int,
  response_body         text,
  error_message         text,
  sent_at               timestamptz not null default now()
);

create index if not exists acutrack_send_log_order_idx  on aa_01_campaigns.acutrack_send_log (shopify_order_id);
create index if not exists acutrack_send_log_sent_idx   on aa_01_campaigns.acutrack_send_log (sent_at desc);
