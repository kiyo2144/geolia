-- AR配置データとしてYouTube動画を登録できるようにする。
-- 動画ファイルは保存せず、storage_path に "youtube:<動画ID>" を入れて公式の埋め込みプレーヤーで再生する。
-- ar_data_assets のasset_type・formatのcheck制約に 'video' / 'youtube' を追加する
-- （制約名は 20260913100000_ar_data_assets_html.sql で付け替えたものと同じ）。
-- ar_placements_nearby等のRPCはasset_type・format・storage_pathをそのまま返すだけなので変更不要。

alter table public.ar_data_assets
  drop constraint if exists ar_data_assets_asset_type_check;
alter table public.ar_data_assets
  add constraint ar_data_assets_asset_type_check
  check (asset_type in ('point_cloud','gaussian_splat','image','vrm','html','video'));

alter table public.ar_data_assets
  drop constraint if exists ar_data_assets_format_check;
alter table public.ar_data_assets
  add constraint ar_data_assets_format_check
  check (format in ('ply','splat','ksplat','sog','spz','jpg','jpeg','png','webp','gif','vrm','html','htm','youtube'));
