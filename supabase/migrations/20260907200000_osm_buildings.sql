-- OpenStreetMapの建物データ（要件定義4.4.1章のサンプル地理データに準ずる、読み取り専用）
-- 高さはOSMのheight/building:levelsタグから推定する（4.4.4章「高さ算出方法の統一方針」と同様、
-- 実測値が無い場合は決定的な推定値を用いる）。

create table public.osm_buildings (
  id uuid primary key default gen_random_uuid(),
  osm_id bigint,
  name text,
  building_type text,
  height numeric not null,
  height_source text not null check (height_source in ('tag', 'levels', 'default')),
  geom geometry(Polygon, 4326) not null,
  created_at timestamptz not null default now()
);
create index osm_buildings_geom_idx on public.osm_buildings using gist (geom);

alter table public.osm_buildings enable row level security;
create policy "osm_buildings_select_all" on public.osm_buildings for select using (true);

-- 森林簿・地籍と同じ「表示範囲(bbox)内のみ取得する」方式で、/map画面に建物を表示するためのRPC。
create or replace function public.osm_buildings_in_bbox(
  min_lng double precision,
  min_lat double precision,
  max_lng double precision,
  max_lat double precision
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(f), '[]'::jsonb)
  )
  from (
    select jsonb_build_object(
      'type', 'Feature',
      'geometry', ST_AsGeoJSON(ST_ForcePolygonCCW(geom))::jsonb,
      'properties', jsonb_build_object(
        'id', id,
        'name', name,
        'building_type', building_type,
        'height', height,
        'height_source', height_source
      )
    ) as f
    from public.osm_buildings
    where geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    limit 3000
  ) t
$$;
