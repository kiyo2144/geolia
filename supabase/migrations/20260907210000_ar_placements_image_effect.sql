-- AR設置の画像・GIF対応（要件定義4.1.2章・4.1.3章）向け。
-- decoration_preset_key（装飾フレーム）は既存カラムを流用し、新たに画像用エフェクトの
-- 選択（キラキラ・ハート・紙吹雪・なし）を保存するカラムを追加する。

alter table public.ar_placements
  add column if not exists image_effect_key text;

-- /map画面向け（プレビュー表示に使う可能性のため一応含める）
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

-- AR閲覧機能向け。画像・GIFを詳細表示する際にstorage_pathに加えて
-- decoration_preset_key（装飾フレーム）・image_effect_key（エフェクト）が必要なため追加する。
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
