-- フェーズ①: ar_placementsの更新（一人称視点画面からの既存AR配置編集）を許可する。
-- select/insertは既に全許可されているが、updateポリシーが存在せず、RLSにより
-- 更新が常に0件ヒットで無言失敗していた（エラーなしで反映されない不具合）。
create policy "ar_placements_update_all" on public.ar_placements for update using (true) with check (true);
