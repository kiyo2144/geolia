# Supabase マイグレーション

`docs/requirements.md` 6章のテーブル設計に対応するSQLマイグレーションです。

## 適用方法

- **Supabase CLIを使う場合**: `supabase link --project-ref <project-ref>` の後、`supabase db push`
- **CLIを使わない場合**: Supabaseダッシュボードの SQL Editor に `migrations/` 内のファイルを番号順に貼り付けて実行

## ファイル構成

- `20260907120000_initial_schema.sql` — テーブル定義・インデックス・RLSポリシー（フェーズ①想定）
- `20260907120100_storage_buckets.sql` — Storageバケットとそのアクセスポリシー

RLSポリシーはフェーズ①（認証なし）を前提にしています。フェーズ②・③（`docs/requirements.md` 4.5章）でアカウント機能を導入する際は、ポリシーの見直しが必要です。

## 既知の警告（対応不要）

Supabaseダッシュボードの Security Advisor で、`public.spatial_ref_sys` に対する「RLS Disabled in Public」という警告が出ることがあります。

- これはPostGIS拡張機能を有効化すると自動的に作られる、座標系定義の参照テーブル（無害な公開データのみ、機密情報なし）です。
- このテーブルは通常のプロジェクトオーナー権限では所有者になれない特殊なテーブルのため、`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` を実行しても `must be owner of table spatial_ref_sys`（権限エラー）になり、そもそも直接は対応できません。
- Supabase側でも把握されている既知の制約であり、対応不要（無視してよい）警告として扱って構いません。
