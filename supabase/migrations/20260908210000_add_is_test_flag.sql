-- テストデータと実データを区別するためのフラグ。
-- 今後、開発・検証用に作成するAR配置・データ資産には is_test = true を設定し、
-- 削除作業の際に実データ（is_test = false）を誤って削除しないようにする。

alter table public.ar_placements
  add column if not exists is_test boolean not null default false;

alter table public.ar_data_assets
  add column if not exists is_test boolean not null default false;

alter table public.ar_motion_assets
  add column if not exists is_test boolean not null default false;
