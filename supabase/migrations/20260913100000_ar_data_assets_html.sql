-- AR配置データとしてHTMLファイル（JavaScript・CSS込みの単一HTML）を登録できるようにする。
-- ar_data_assets のasset_type・formatのcheck制約に 'html' / 'html','htm' を追加する。
-- 制約は初期スキーマ(20260907120000_initial_schema.sql)でカラム定義時にインラインで
-- 付けているため、PostgreSQLの既定の制約名（<テーブル>_<カラム>_check）で付け替える。
-- ar_placements_nearby等のRPCはasset_type・formatをそのまま返すだけなので変更不要。

alter table public.ar_data_assets
  drop constraint if exists ar_data_assets_asset_type_check;
alter table public.ar_data_assets
  add constraint ar_data_assets_asset_type_check
  check (asset_type in ('point_cloud','gaussian_splat','image','vrm','html'));

alter table public.ar_data_assets
  drop constraint if exists ar_data_assets_format_check;
alter table public.ar_data_assets
  add constraint ar_data_assets_format_check
  check (format in ('ply','splat','ksplat','sog','spz','jpg','jpeg','png','webp','gif','vrm','html','htm'));
