-- 初期スキーマ
-- 対応する要件定義: docs/requirements.md 6章
-- フェーズ①（認証なし）を前提としたRLSポリシーを含む。フェーズ②・③導入時に見直すこと（requirements.md 4.5章参照）。

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- =========================================================
-- 管理者フラグ（requirements.md 6.2章 / 4.5章）
-- =========================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 管理者判定用ヘルパー関数。security definer によりRLSをバイパスして参照するため、
-- profiles テーブル自身のポリシー内で使っても無限再帰にならない。
create function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create policy "profiles_select_own_or_admin"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

-- 新規サインアップ時に profiles 行を自動作成する（is_admin はデフォルトfalse。
-- 管理者への昇格はSupabaseダッシュボード等から手動で行う想定）
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =========================================================
-- AR設置（requirements.md 6.2章 / 4.1章）
-- =========================================================

create table public.ar_data_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),      -- 認証未導入の間はNULL
  asset_type text not null
    check (asset_type in ('point_cloud','gaussian_splat','image','vrm')),
  storage_path text not null,
  original_filename text,
  format text not null
    check (format in ('ply','splat','ksplat','sog','spz','jpg','jpeg','png','webp','gif','vrm')),
  file_size_bytes bigint,
  created_at timestamptz not null default now()
);

create table public.ar_motion_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  storage_path text not null,
  original_filename text,
  format text not null check (format in ('vrma')),
  created_at timestamptz not null default now()
);

create table public.ar_placements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  data_asset_id uuid not null references public.ar_data_assets(id),
  label text,
  lat double precision not null,
  lng double precision not null,
  altitude double precision,
  rotation_x double precision not null default 0,
  rotation_y double precision not null default 0,
  scale double precision not null default 1,
  vertical_offset double precision not null default 0,
  motion_preset_key text,
  motion_asset_id uuid references public.ar_motion_assets(id),
  decoration_preset_key text,
  geom geometry(Point, 4326)
    generated always as (st_setsrid(st_makepoint(lng, lat), 4326)) stored,
  created_at timestamptz not null default now()
);
create index ar_placements_geom_idx on public.ar_placements using gist (geom);

alter table public.ar_data_assets enable row level security;
alter table public.ar_motion_assets enable row level security;
alter table public.ar_placements enable row level security;

-- フェーズ①: 誰でも閲覧・保存できる（requirements.md 4.1章・9章）
create policy "ar_data_assets_select_all" on public.ar_data_assets for select using (true);
create policy "ar_data_assets_insert_all" on public.ar_data_assets for insert with check (true);

create policy "ar_motion_assets_select_all" on public.ar_motion_assets for select using (true);
create policy "ar_motion_assets_insert_all" on public.ar_motion_assets for insert with check (true);

create policy "ar_placements_select_all" on public.ar_placements for select using (true);
create policy "ar_placements_insert_all" on public.ar_placements for insert with check (true);

-- =========================================================
-- サンプル地理データ（requirements.md 6.2章 / 4.4.1章、読み取り専用）
-- =========================================================

create table public.forest_parcels (
  id uuid primary key default gen_random_uuid(),
  rinhan text,
  shohan text,
  sehyoban text,
  height numeric,
  color text,
  geom geometry(Polygon, 4326) not null,
  created_at timestamptz not null default now()
);
create index forest_parcels_geom_idx on public.forest_parcels using gist (geom);

create table public.land_parcels (
  id text primary key,
  city_code text,
  oaza_code text,
  chome_code text,
  koaza_code text,
  city_name text,
  oaza_name text,
  koaza_name text,
  chiban text,
  precision_class text,
  coordinate_type text,
  map_name text,
  coordinate_system text,
  datum_type text,
  height numeric,
  color_koaza text,
  color_seido text,
  geom geometry(Polygon, 4326) not null,
  created_at timestamptz not null default now()
);
create index land_parcels_geom_idx on public.land_parcels using gist (geom);

alter table public.forest_parcels enable row level security;
alter table public.land_parcels enable row level security;

-- 読み取り専用。書き込みはデータ移行スクリプト（service role）でのみ行う
create policy "forest_parcels_select_all" on public.forest_parcels for select using (true);
create policy "land_parcels_select_all" on public.land_parcels for select using (true);

-- =========================================================
-- ユーザーアップロードの地理データ（requirements.md 6.2章 / 4.4.2章）
-- =========================================================

create table public.geo_datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  name text not null,
  description text,
  source_format text not null check (source_format in ('shapefile','geojson')),
  storage_path text not null,
  visibility text not null default 'private' check (visibility in ('private','public')),
  status text not null default 'processing' check (status in ('processing','ready','failed')),
  created_at timestamptz not null default now()
);

create table public.geo_features (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.geo_datasets(id) on delete cascade,
  properties jsonb not null default '{}'::jsonb,
  height numeric,
  color text,
  geom geometry(Geometry, 4326) not null,
  created_at timestamptz not null default now()
);
create index geo_features_dataset_idx on public.geo_features (dataset_id);
create index geo_features_geom_idx on public.geo_features using gist (geom);
create index geo_features_properties_idx on public.geo_features using gin (properties);

alter table public.geo_datasets enable row level security;
alter table public.geo_features enable row level security;

-- 閲覧: 公開データセット、または本人・管理者のデータセットのみ
create policy "geo_datasets_select_visible"
  on public.geo_datasets for select
  using (
    visibility = 'public'
    or (auth.uid() is not null and user_id = auth.uid())
    or public.is_admin()
  );

-- 書き込み: フェーズ①では管理者限定（requirements.md 4.4.2章・9章）
create policy "geo_datasets_insert_admin_only"
  on public.geo_datasets for insert
  with check (public.is_admin());

create policy "geo_datasets_update_owner_or_admin"
  on public.geo_datasets for update
  using (
    (auth.uid() is not null and user_id = auth.uid())
    or public.is_admin()
  );

create policy "geo_features_select_visible"
  on public.geo_features for select
  using (
    exists (
      select 1 from public.geo_datasets d
      where d.id = dataset_id
        and (
          d.visibility = 'public'
          or (auth.uid() is not null and d.user_id = auth.uid())
          or public.is_admin()
        )
    )
  );

create policy "geo_features_insert_admin_only"
  on public.geo_features for insert
  with check (public.is_admin());

-- =========================================================
-- ユーザーごとの表示データセット選択（requirements.md 6.2章 / 4.4.2章、フェーズ②以降）
-- =========================================================

create table public.user_dataset_selections (
  user_id uuid not null references auth.users(id),
  dataset_id uuid not null references public.geo_datasets(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, dataset_id)
);

alter table public.user_dataset_selections enable row level security;

create policy "user_dataset_selections_own_rows"
  on public.user_dataset_selections for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
