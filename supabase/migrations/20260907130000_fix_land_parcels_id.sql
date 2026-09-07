-- land_parcels.id（元データのID）は一意ではないことが判明したため（同一IDが最大17回重複）、
-- 生成UUIDを主キーにし、元データのIDは source_id 列として非一意のまま保持する。
-- 対応する要件定義: docs/requirements.md 6.2章

alter table public.land_parcels drop constraint land_parcels_pkey;
alter table public.land_parcels rename column id to source_id;
alter table public.land_parcels add column id uuid not null default gen_random_uuid() primary key;

create index land_parcels_source_id_idx on public.land_parcels (source_id);
