-- マップ画面（/map）向け: 表示範囲（バウンディングボックス）内のデータだけをGeoJSONとして返す関数。
-- 対応する要件定義: docs/requirements.md 8章（全件を一度にGeoJSONとして返さない）
--
-- 呼び出し例（Supabase JSクライアント）:
--   supabase.rpc('forest_parcels_in_bbox', { min_lng, min_lat, max_lng, max_lat })

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
    'features', coalesce(jsonb_agg(
      jsonb_build_object(
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
      )
    ), '[]'::jsonb)
  )
  from public.forest_parcels
  where geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
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
    'features', coalesce(jsonb_agg(
      jsonb_build_object(
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
      )
    ), '[]'::jsonb)
  )
  from public.land_parcels
  where geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
$$;

grant execute on function public.forest_parcels_in_bbox(double precision, double precision, double precision, double precision) to anon, authenticated;
grant execute on function public.land_parcels_in_bbox(double precision, double precision, double precision, double precision) to anon, authenticated;
