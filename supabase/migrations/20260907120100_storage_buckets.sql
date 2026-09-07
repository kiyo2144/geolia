-- Storageバケット定義
-- 対応する要件定義: docs/requirements.md 6.3章
-- フェーズ①: 当面は公開読み取り可（署名付きURLへの変更は将来検討、requirements.md 6.3章参照）

insert into storage.buckets (id, name, public)
values
  ('ar-assets', 'ar-assets', true),
  ('ar-motion-assets', 'ar-motion-assets', true),
  ('geo-datasets', 'geo-datasets', true)
on conflict (id) do nothing;

-- 読み取り: 全バケット公開
create policy "ar_assets_public_read"
  on storage.objects for select
  using (bucket_id = 'ar-assets');

create policy "ar_motion_assets_public_read"
  on storage.objects for select
  using (bucket_id = 'ar-motion-assets');

create policy "geo_datasets_public_read"
  on storage.objects for select
  using (bucket_id = 'geo-datasets');

-- 書き込み: ar-assets / ar-motion-assets はフェーズ①では誰でもアップロード可
-- （requirements.md 4.1章、ar_placements/ar_data_assetsの挿入ポリシーと合わせる）
create policy "ar_assets_insert_all"
  on storage.objects for insert
  with check (bucket_id = 'ar-assets');

create policy "ar_motion_assets_insert_all"
  on storage.objects for insert
  with check (bucket_id = 'ar-motion-assets');

-- geo-datasets はフェーズ①では管理者限定（requirements.md 4.4.2章・9章）
-- public.is_admin() は 20260907120000_initial_schema.sql で定義済み
create policy "geo_datasets_insert_admin_only"
  on storage.objects for insert
  with check (bucket_id = 'geo-datasets' and public.is_admin());
