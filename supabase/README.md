# Supabase マイグレーション

`docs/requirements.md` 6章のテーブル設計に対応するSQLマイグレーションです。

## 適用方法

- **Supabase CLIを使う場合**: `supabase link --project-ref <project-ref>` の後、`supabase db push`
- **CLIを使わない場合**: Supabaseダッシュボードの SQL Editor に `migrations/` 内のファイルを番号順に貼り付けて実行

## ファイル構成

- `20260907120000_initial_schema.sql` — テーブル定義・インデックス・RLSポリシー（フェーズ①想定）
- `20260907120100_storage_buckets.sql` — Storageバケットとそのアクセスポリシー

RLSポリシーはフェーズ①（認証なし）を前提にしています。フェーズ②・③（`docs/requirements.md` 4.5章）でアカウント機能を導入する際は、ポリシーの見直しが必要です。
