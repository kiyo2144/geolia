-- 3Dマップのポップアップに、VRM（モーション込み）・点群・Gaussian Splatの
-- カメラ不要3Dプレビューを埋め込む機能向け。/map画面が使うar_placements_in_bboxに、
-- 元データのstorage_pathと、VRMのモーション情報（プリセットキー・アップロード
-- モーションのstorage_path）を追加する。

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
        'storage_path', a.storage_path,
        'motion_preset_key', p.motion_preset_key,
        'motion_storage_path', m.storage_path,
        'preview_storage_path', p.preview_storage_path,
        'created_at', p.created_at
      )
    ) as f
    from public.ar_placements p
    join public.ar_data_assets a on a.id = p.data_asset_id
    left join public.ar_motion_assets m on m.id = p.motion_asset_id
    where p.geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    limit 500
  ) t
$$;
