-- AR閲覧機能（要件定義 docs/requirements.md 4.2章・6.4章）向け。
-- 現在地から半径radius_meters以内のAR配置を、距離が近い順に最大max_count件取得する。
-- ここで返す情報は位置・名前・データ種別・保存先パスなど軽量な情報のみで、
-- 3Dデータ本体（storage_pathの指す実ファイル）はこの時点ではダウンロードしない。

create or replace function public.ar_placements_nearby(
  center_lng double precision,
  center_lat double precision,
  radius_meters double precision default 300,
  max_count integer default 100
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
        'rotation_x', p.rotation_x,
        'rotation_y', p.rotation_y,
        'scale', p.scale,
        'asset_type', a.asset_type,
        'format', a.format,
        'storage_path', a.storage_path,
        'distance_meters', ST_Distance(
          p.geom::geography,
          ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography
        )
      )
    ) as f
    from public.ar_placements p
    join public.ar_data_assets a on a.id = p.data_asset_id
    where ST_DWithin(
      p.geom::geography,
      ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography,
      radius_meters
    )
    order by ST_Distance(
      p.geom::geography,
      ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography
    )
    limit max_count
  ) t
$$;
