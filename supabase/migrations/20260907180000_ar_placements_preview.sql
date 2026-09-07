-- AR配置のプレビュー画像（設置時のカメラ映像＋3Dデータの合成スクリーンショット）を
-- 保存できるようにする。ar-assetsバケットに他のARデータと同様に保存する。
-- 対応する要件定義: 3DマップでAR配置ピンをクリックした際にプレビュー画像を表示する機能

alter table public.ar_placements
  add column if not exists preview_storage_path text;

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
        'preview_storage_path', p.preview_storage_path,
        'created_at', p.created_at
      )
    ) as f
    from public.ar_placements p
    join public.ar_data_assets a on a.id = p.data_asset_id
    where p.geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    limit 500
  ) t
$$;
