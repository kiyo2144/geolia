-- AR設置のVRM対応（要件定義4.1.2章・4.1.3章）向け。
-- motion_preset_key・motion_asset_idは既存カラムを流用する。AR閲覧機能で
-- モーションを再生するには、motion_asset_idが指すar_motion_assetsのstorage_pathを
-- 解決して返す必要があるため、ar_placements_nearby RPCにLEFT JOINで追加する。

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
        'decoration_preset_key', p.decoration_preset_key,
        'image_effect_key', p.image_effect_key,
        'motion_preset_key', p.motion_preset_key,
        'motion_storage_path', m.storage_path,
        'distance_meters', ST_Distance(
          p.geom::geography,
          ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography
        )
      )
    ) as f
    from public.ar_placements p
    join public.ar_data_assets a on a.id = p.data_asset_id
    left join public.ar_motion_assets m on m.id = p.motion_asset_id
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
