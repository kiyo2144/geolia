-- 森林簿・地籍と同じ「表示範囲(bbox)内のみ取得する」方式で、AR配置(ar_placements)を
-- 3Dマップ画面(/map)に表示するためのRPC関数。
-- 対応する要件定義: docs/requirements.md 5章（/map画面で配置済みARピンを一覧表示）

create or replace function public.ar_placements_in_bbox(
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
      'geometry', ST_AsGeoJSON(p.geom)::jsonb,
      'properties', jsonb_build_object(
        'id', p.id,
        'label', p.label,
        'lat', p.lat,
        'lng', p.lng,
        'altitude', p.altitude,
        'asset_type', a.asset_type,
        'format', a.format,
        'created_at', p.created_at
      )
    ) as f
    from public.ar_placements p
    join public.ar_data_assets a on a.id = p.data_asset_id
    where p.geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    limit 500
  ) t
$$;
