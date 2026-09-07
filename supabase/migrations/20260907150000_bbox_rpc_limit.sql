-- 広い表示範囲（バウンディングボックス）で大量の地籍筆を集計しようとすると
-- statement timeout (57014) が発生することが実機テストで判明したため、
-- 安全弁として1回あたりの返却件数に上限を設ける。
-- 対応する要件定義: docs/requirements.md 8章（全件を一度にGeoJSONとして返さない）

create or replace function public.forest_parcels_in_bbox(
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
      'geometry', ST_AsGeoJSON(geom)::jsonb,
      'properties', jsonb_build_object(
        'id', id,
        'rinhan', rinhan,
        'shohan', shohan,
        'sehyoban', sehyoban,
        'height', height,
        'color', color
      )
    ) as f
    from public.forest_parcels
    where geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    limit 3000
  ) t
$$;

create or replace function public.land_parcels_in_bbox(
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
      'geometry', ST_AsGeoJSON(geom)::jsonb,
      'properties', jsonb_build_object(
        'id', id,
        'koaza_name', koaza_name,
        'chiban', chiban,
        'precision_class', precision_class,
        'height', height,
        'color_koaza', color_koaza,
        'color_seido', color_seido
      )
    ) as f
    from public.land_parcels
    where geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    limit 3000
  ) t
$$;
