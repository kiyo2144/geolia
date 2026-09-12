import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// AR配置の削除（管理者用・簡易保護）。
//
// このアプリはフェーズ①のため認証機能・所有者判定が無く、ar_placementsには
// DELETE用のRLSポリシーも設けていない（一般公開のanonキーで誰でも削除できて
// しまう状態を避けるため）。そのため削除はこのサーバー側APIルート経由のみとし、
// 固定パスワード（ADMIN_DELETE_PASSWORD、サーバー専用）による簡易的な保護と、
// サービスロールキー（RLSを回避する管理者権限）での削除を行う。
// 本格的な認証・所有者ベースの権限管理はフェーズ②で見直す想定。

export async function POST(request) {
  const { placementId, password } = await request.json();

  if (!process.env.ADMIN_DELETE_PASSWORD) {
    return NextResponse.json({ error: "サーバー側でADMIN_DELETE_PASSWORDが未設定です" }, { status: 500 });
  }
  if (password !== process.env.ADMIN_DELETE_PASSWORD) {
    return NextResponse.json({ error: "パスワードが違います" }, { status: 401 });
  }
  if (!placementId) {
    return NextResponse.json({ error: "placementIdが必要です" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const { data: placement, error: fetchError } = await supabase
    .from("ar_placements")
    .select("id, data_asset_id, motion_asset_id, preview_storage_path")
    .eq("id", placementId)
    .single();
  if (fetchError || !placement) {
    return NextResponse.json({ error: "配置が見つかりません" }, { status: 404 });
  }

  const [{ data: dataAsset }, { data: motionAsset }] = await Promise.all([
    supabase.from("ar_data_assets").select("storage_path").eq("id", placement.data_asset_id).single(),
    placement.motion_asset_id
      ? supabase.from("ar_motion_assets").select("storage_path").eq("id", placement.motion_asset_id).single()
      : Promise.resolve({ data: null }),
  ]);

  const { error: deleteError } = await supabase.from("ar_placements").delete().eq("id", placementId);
  if (deleteError) {
    return NextResponse.json({ error: "配置の削除に失敗しました" }, { status: 500 });
  }

  // 以降は付随データの後始末。失敗してもAR配置自体は削除済みのため、
  // エラーはログのみに留めてレスポンスは成功として返す。
  await supabase.from("ar_data_assets").delete().eq("id", placement.data_asset_id);
  if (placement.motion_asset_id) {
    await supabase.from("ar_motion_assets").delete().eq("id", placement.motion_asset_id);
  }

  const storagePathsToRemove = [dataAsset?.storage_path, placement.preview_storage_path].filter(Boolean);
  if (storagePathsToRemove.length > 0) {
    await supabase.storage.from("ar-assets").remove(storagePathsToRemove);
  }
  if (motionAsset?.storage_path) {
    await supabase.storage.from("ar-motion-assets").remove([motionAsset.storage_path]);
  }

  return NextResponse.json({ success: true });
}
