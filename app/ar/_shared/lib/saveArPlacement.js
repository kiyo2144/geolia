import { getAssetType, getFileFormat } from "./dataFormat";

/**
 * AR配置データ（ファイル・プレビュー画像・任意でVRMモーション）をアップロードし、
 * ar_data_assets / ar_placements テーブルに登録する。
 * カメラ経由のAR設置(ar/new)と、カメラを使わないデスクトップ設置(一人称視点)の
 * 両方から共通で使う保存処理。
 *
 * onStatus: 進捗メッセージを画面に表示するためのコールバック（省略可）
 */
export async function saveArPlacement(
  supabase,
  {
    dataFile,
    dataFormat,
    label,
    lat,
    lng,
    altitude,
    rotationX,
    rotationY,
    scale,
    verticalOffset,
    previewBlob,
    decorationPresetKey,
    imageEffectKey,
    motionSourceMode,
    motionPresetKey,
    motionFile,
    onStatus,
  },
) {
  const format = getFileFormat(dataFile);
  const storagePath = `${crypto.randomUUID()}.${format}`;

  onStatus?.("アップロード中...");
  const { error: uploadError } = await supabase.storage.from("ar-assets").upload(storagePath, dataFile, {
    contentType: dataFile.type || "application/octet-stream",
  });
  if (uploadError) throw uploadError;

  // プレビュー画像は無くても配置の保存自体は継続する（あくまで補助的な情報のため）
  let previewStoragePath = null;
  if (previewBlob) {
    const previewPath = `${crypto.randomUUID()}-preview.jpg`;
    const { error: previewUploadError } = await supabase.storage
      .from("ar-assets")
      .upload(previewPath, previewBlob, { contentType: "image/jpeg" });
    if (previewUploadError) {
      console.error("プレビュー画像のアップロードに失敗しました:", previewUploadError);
    } else {
      previewStoragePath = previewPath;
    }
  }

  // VRM用: モーションファイルがアップロードされていれば、専用バケット・テーブルに登録する
  let motionAssetId = null;
  if (dataFormat === "vrm" && motionSourceMode === "upload" && motionFile) {
    onStatus?.("モーションファイルをアップロード中...");
    const motionStoragePath = `${crypto.randomUUID()}.vrma`;
    const { error: motionUploadError } = await supabase.storage
      .from("ar-motion-assets")
      .upload(motionStoragePath, motionFile, {
        contentType: motionFile.type || "application/octet-stream",
      });
    if (motionUploadError) throw motionUploadError;

    const { data: motionAssetRow, error: motionAssetError } = await supabase
      .from("ar_motion_assets")
      .insert({
        storage_path: motionStoragePath,
        original_filename: motionFile.name,
        format: "vrma",
      })
      .select()
      .single();
    if (motionAssetError) throw motionAssetError;
    motionAssetId = motionAssetRow.id;
  }

  onStatus?.("データを登録中...");
  const { data: assetRow, error: assetError } = await supabase
    .from("ar_data_assets")
    .insert({
      asset_type: getAssetType(dataFormat),
      storage_path: storagePath,
      original_filename: dataFile.name,
      format,
      file_size_bytes: dataFile.size,
    })
    .select()
    .single();
  if (assetError) throw assetError;

  onStatus?.("配置情報を保存中...");
  const { error: placementError } = await supabase.from("ar_placements").insert({
    data_asset_id: assetRow.id,
    label: label.trim(),
    lat,
    lng,
    altitude,
    rotation_x: rotationX,
    rotation_y: rotationY,
    scale,
    vertical_offset: verticalOffset,
    preview_storage_path: previewStoragePath,
    decoration_preset_key: dataFormat === "image" || dataFormat === "gif" ? decorationPresetKey : null,
    image_effect_key: dataFormat === "image" || dataFormat === "gif" ? imageEffectKey : null,
    motion_preset_key: dataFormat === "vrm" && motionSourceMode === "preset" ? motionPresetKey : null,
    motion_asset_id: dataFormat === "vrm" && motionSourceMode === "upload" ? motionAssetId : null,
  });
  if (placementError) throw placementError;
}

/**
 * 既存のAR配置の位置・向き・高さ・拡大縮小・名前を更新する（ファイル自体の差し替えは
 * 対象外。ファイル差し替えが必要な場合は新規に設置し直す運用を想定）。
 */
export async function updateArPlacement(
  supabase,
  placementId,
  { label, lat, lng, altitude, rotationX, rotationY, scale, verticalOffset, onStatus },
) {
  onStatus?.("配置情報を更新中...");
  const { error } = await supabase
    .from("ar_placements")
    .update({
      label: label.trim(),
      lat,
      lng,
      altitude,
      rotation_x: rotationX,
      rotation_y: rotationY,
      scale,
      vertical_offset: verticalOffset,
    })
    .eq("id", placementId);
  if (error) throw error;
}
