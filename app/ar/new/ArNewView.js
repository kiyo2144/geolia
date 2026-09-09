"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ARScene } from "../_shared/components/ARScene";
import { CameraBackground } from "../_shared/components/CameraBackground";
import { CompassHint } from "../_shared/components/CompassHint";
import { useArGestureControls } from "../_shared/hooks/useArGestureControls";
import { useCameraStream } from "../_shared/hooks/useCameraStream";
import { useDeviceOrientation } from "../_shared/hooks/useDeviceOrientation";
import { useGeolocation } from "../_shared/hooks/useGeolocation";
import { localMetersToLatLng } from "../../_shared/lib/geoMath";
import { PlacementLocationMap } from "../../_shared/components/PlacementLocationMap";
import styles from "./ArNewView.module.css";

// x/z(水平位置)は「狙い撃ち配置」で決まるため、微調整では上下移動・回転・拡大縮小のみ扱う
const DEFAULT_ADJUSTMENT = { y: 0, rotationX: 0, rotationY: 0, scale: 1 };

// 2本指を上下にスライドした時、1pxあたりどれだけ高さ(メートル)を動かすか
const VERTICAL_METERS_PER_PIXEL = 0.01;
const MIN_SCALE = 0.05;
const MAX_SCALE = 50;

// 静止画・GIFは平面（板状）で表示されるため、点群等に比べて同じ回転・上下移動量でも
// 見た目の変化が乏しく操作しにくい。データ種別ごとに回転・上下移動の感度を補正する。
const GESTURE_SENSITIVITY_MULTIPLIERS = { image: 2.5, gif: 2.5 };
const getGestureSensitivityMultiplier = (dataFormat) =>
  GESTURE_SENSITIVITY_MULTIPLIERS[dataFormat] ?? 1;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// 画像・GIF用の装飾フレーム／エフェクトの初期セット（要件定義 docs/requirements.md 4.1.3章）
const DECORATION_OPTIONS = [
  { value: "none", label: "なし" },
  { value: "white", label: "シンプル白枠" },
  { value: "polaroid", label: "ポラロイド風" },
];
const IMAGE_EFFECT_OPTIONS = [
  { value: "none", label: "なし" },
  { value: "sparkle", label: "キラキラ" },
  { value: "heart", label: "ハート" },
  { value: "confetti", label: "紙吹雪" },
];
// VRM定型モーションの初期セット（要件定義 docs/requirements.md 4.1.3章）
const MOTION_PRESET_OPTIONS = [
  { value: "idle", label: "待機" },
  { value: "wave", label: "手を振る" },
  { value: "bow", label: "お辞儀" },
  { value: "jump", label: "ジャンプ" },
];

// 対応データ種別ごとのファイルサイズ上限（要件定義 docs/requirements.md 4.1.4章）
const SPLAT_EXTENSIONS = ["spz", "splat", "ksplat", "sog"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const FILE_SIZE_LIMITS_BYTES = {
  ply: 100 * 1024 * 1024,
  splat: 50 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  gif: 20 * 1024 * 1024,
  vrm: 50 * 1024 * 1024,
};
const FILE_SIZE_LIMIT_LABELS = {
  ply: "100MB",
  splat: "50MB",
  image: "20MB",
  gif: "20MB",
  vrm: "50MB",
};
const MOTION_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const MOTION_FILE_SIZE_LIMIT_LABEL = "10MB";

function getFileFormat(file) {
  if (!file) return null;
  const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : null;
}

// 拡張子から、点群(PLY)・Gaussian Splat・静止画・GIF・VRMのどれとして読むかを判定する。
// iOSの「ファイル」アプリでは、拡張子だけの独自フォーマット（.spz等）が選択できない
// （グレーアウトする）ことがあるため、accept属性を汎用バイナリにも広げて選択自体は
// できるようにしている。その分、ここで対応拡張子かどうかを厳密にチェックする。
function getDataFormat(file) {
  const format = getFileFormat(file);
  if (!format) return null;
  if (format === "ply") return "ply";
  if (SPLAT_EXTENSIONS.includes(format)) return "splat";
  if (format === "gif") return "gif";
  if (format === "vrm") return "vrm";
  if (IMAGE_EXTENSIONS.includes(format)) return "image";
  return null;
}

// @sparkjsdev/spark の SplatFileType（文字列）に対応する拡張子ごとの値。
// アップロード直後のプレビューは拡張子の無い一時URL（blob:）を使うため、
// url任せの自動判別に頼らずこちらを明示的に渡す（詳細はSplatObject.jsのコメント参照）。
const SPLAT_FILE_TYPE_BY_EXTENSION = {
  spz: "spz",
  splat: "splat",
  ksplat: "ksplat",
  sog: "pcsogs",
};

function getAssetType(dataFormat) {
  if (dataFormat === "splat") return "gaussian_splat";
  if (dataFormat === "image" || dataFormat === "gif") return "image";
  if (dataFormat === "vrm") return "vrm";
  return "point_cloud";
}

export function ArNewView() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [step, setStep] = useState("upload");
  const [dataFile, setDataFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [placement, setPlacement] = useState(null); // { lat, lng, altitude }
  // アンカー（配置）確定時点の自己位置のスナップショット。確定後はGPSの更新を
  // 反映せずこれを使い続けることで、GPSの揺れでアンカーが動いて見えるのを防ぐ
  // （視覚トラッキングの代わりに、確定後は自己位置を凍結する簡易的な対策）。
  const [frozenUserPosition, setFrozenUserPosition] = useState(null);
  const [adjustment, setAdjustment] = useState(DEFAULT_ADJUSTMENT);
  const [isAdjustMode, setIsAdjustMode] = useState(true);
  // 'aiming'(狙い撃ちで大まかな位置合わせ) | 'fine-tune'(回転・上下移動などの微調整)
  const [arSubMode, setArSubMode] = useState("aiming");
  // 現在確定しているジェスチャー操作。矢印ギズモの表示に使う。
  const [activeGesture, setActiveGesture] = useState(null);
  const [gestureDirection, setGestureDirection] = useState(0);
  // null | 'original'(元データの色) | 'gradient'(色情報が無く高さで自動着色)
  const [colorInfo, setColorInfo] = useState(null);
  // 画像・GIF用: 装飾フレーム('none' | 'white' | 'polaroid')とエフェクト('none' | 'sparkle' | 'heart' | 'confetti')
  const [decorationPresetKey, setDecorationPresetKey] = useState("none");
  const [imageEffectKey, setImageEffectKey] = useState("none");
  // VRM用: モーションの与え方('preset'=定型モーション | 'upload'=モーションファイルをアップロード)
  const [motionSourceMode, setMotionSourceMode] = useState("preset");
  const [motionPresetKey, setMotionPresetKey] = useState("idle");
  const [motionFile, setMotionFile] = useState(null);
  const [motionFileError, setMotionFileError] = useState(null);
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [isSaved, setIsSaved] = useState(false);
  // 設置確定時に撮影した、カメラ映像＋3Dデータの合成プレビュー画像
  const [previewBlob, setPreviewBlob] = useState(null);

  const geolocation = useGeolocation({ watch: true });
  const deviceOrientation = useDeviceOrientation();
  const cameraStream = useCameraStream();

  // 狙い撃ちモードでカメラ正面に表示している地点のローカル座標(east/north)。
  // Canvas内で毎フレーム更新され、「ここに配置」ボタン押下時に読み取る。
  const aimPointRef = useRef({ east: 0, north: 0 });
  // プレビュー画像撮影用。ARScene側で生成されたcanvas要素への参照。
  const arCanvasRef = useRef(null);

  const dataFormat = useMemo(() => getDataFormat(dataFile), [dataFile]);
  const splatFileType = useMemo(
    () => (dataFormat === "splat" ? SPLAT_FILE_TYPE_BY_EXTENSION[getFileFormat(dataFile)] : undefined),
    [dataFormat, dataFile],
  );

  // アップロードされたファイルから three.js / Spark が読める一時URLを作る
  const dataUrl = useMemo(() => (dataFile ? URL.createObjectURL(dataFile) : null), [dataFile]);

  useEffect(() => {
    return () => {
      if (dataUrl) URL.revokeObjectURL(dataUrl);
    };
  }, [dataUrl]);

  // VRM用: アップロードされたモーションファイル(.vrma)の一時URL
  const motionFileUrl = useMemo(
    () => (motionFile ? URL.createObjectURL(motionFile) : null),
    [motionFile],
  );

  useEffect(() => {
    return () => {
      if (motionFileUrl) URL.revokeObjectURL(motionFileUrl);
    };
  }, [motionFileUrl]);

  // プレビュー画像（Blob）の表示用URL
  const previewUrl = useMemo(
    () => (previewBlob ? URL.createObjectURL(previewBlob) : null),
    [previewBlob],
  );
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // カメラ映像とAR描画(three.jsのcanvas)を合成し、設置時点の見た目を
  // プレビュー画像として撮影する。カメラを使わず現在地をそのまま設置場所にした
  // 場合はcanvasが存在しないため、その場合はプレビューを生成しない。
  const capturePreview = () => {
    const video = cameraStream.videoRef.current;
    const arCanvas = arCanvasRef.current;
    if (!video || !arCanvas || video.readyState < 2) return;

    const rect = video.getBoundingClientRect();
    const width = Math.round(rect.width) || video.videoWidth || arCanvas.width;
    const height = Math.round(rect.height) || video.videoHeight || arCanvas.height;
    if (!width || !height) return;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, width, height);
    ctx.drawImage(arCanvas, 0, 0, width, height);
    canvas.toBlob((blob) => {
      if (blob) setPreviewBlob(blob);
    }, "image/jpeg", 0.85);
  };

  // AR配置ステップから離れたらカメラを止める
  useEffect(() => {
    if (step !== "ar" && cameraStream.isActive) {
      cameraStream.stop();
    }
  }, [step, cameraStream]);

  const handleFileChange = (event) => {
    const file = event.target.files?.[0] ?? null;
    if (file) {
      const format = getDataFormat(file);
      if (!format) {
        setFileError("対応していないファイル形式です");
        setDataFile(null);
        setColorInfo(null);
        event.target.value = "";
        return;
      }
      const limitBytes = FILE_SIZE_LIMITS_BYTES[format];
      if (file.size > limitBytes) {
        setFileError(
          `ファイルサイズが上限（${FILE_SIZE_LIMIT_LABELS[format]}）を超えています`,
        );
        setDataFile(null);
        setColorInfo(null);
        event.target.value = "";
        return;
      }
    }
    setFileError(null);
    setDataFile(file);
    setColorInfo(null);
    setDecorationPresetKey("none");
    setImageEffectKey("none");
    setMotionSourceMode("preset");
    setMotionPresetKey("idle");
    setMotionFile(null);
    setMotionFileError(null);
    setIsSaved(false);
  };

  const handleMotionFileChange = (event) => {
    const file = event.target.files?.[0] ?? null;
    if (file) {
      const format = getFileFormat(file);
      if (format !== "vrma") {
        setMotionFileError("モーションファイルは.vrma形式のみ対応しています");
        setMotionFile(null);
        event.target.value = "";
        return;
      }
      if (file.size > MOTION_FILE_SIZE_LIMIT_BYTES) {
        setMotionFileError(
          `ファイルサイズが上限（${MOTION_FILE_SIZE_LIMIT_LABEL}）を超えています`,
        );
        setMotionFile(null);
        event.target.value = "";
        return;
      }
    }
    setMotionFileError(null);
    setMotionFile(file);
    setIsSaved(false);
  };

  // 位置情報・カメラ・端末の向きの許可要求をまとめて行う（「ARを開始」ボタンからの
  // 再試行時にも使うため、狙い撃ち/微調整のどちらから始めるかはここでは変更しない）。
  const handleStartAr = async () => {
    geolocation.start();
    await Promise.all([cameraStream.start(), deviceOrientation.requestPermission()]);
  };

  // データ選択後の「ARの設置に進む」ボタン。位置情報の取得・カメラ・端末の向きの
  // 許可要求をまとめて行い、そのままAR設置画面に遷移する。
  const handleProceedToAr = () => {
    setArSubMode("aiming");
    setStep("ar");
    handleStartAr();
  };

  // 「新規投稿」画面から戻るボタン。既に設置場所が決まっていれば微調整から、
  // まだ決まっていなければ狙い撃ちから再開する。
  const handleBackToAr = () => {
    setArSubMode(placement ? "fine-tune" : "aiming");
    setStep("ar");
    handleStartAr();
  };

  // AR設置画面から戻るボタン。データ選択画面に戻る。
  const handleBackToUpload = () => setStep("upload");

  const deviceHeading = useMemo(() => {
    if (!deviceOrientation.orientation) return null;
    const { compassHeading, alpha } = deviceOrientation.orientation;
    return compassHeading ?? alpha;
  }, [deviceOrientation.orientation]);

  // カメラの正面(狙い撃ち地点)に3Dデータを置いている状態から、実際の設置場所(緯度経度)を確定する
  const handleAimPlace = () => {
    if (!geolocation.position) return;

    const confirmedLatLng = localMetersToLatLng(geolocation.position, aimPointRef.current);
    setPlacement({ ...confirmedLatLng, altitude: geolocation.position.altitude });
    setFrozenUserPosition(geolocation.position);
    setAdjustment(DEFAULT_ADJUSTMENT);
    setArSubMode("fine-tune");
    setIsSaved(false);
    capturePreview();
  };

  const handleBackToAiming = () => setArSubMode("aiming");

  // 微調整が終わり、AR上の位置が決まったら投稿内容の入力画面に進む
  const handleProceedToPost = () => setStep("post");

  const handleGestureModeChange = useCallback((mode) => {
    setActiveGesture(mode);
    if (mode === null) setGestureDirection(0);
  }, []);

  const handleScale = useCallback((ratio) => {
    setGestureDirection(ratio >= 1 ? 1 : -1);
    setAdjustment((prev) => ({ ...prev, scale: clamp(prev.scale * ratio, MIN_SCALE, MAX_SCALE) }));
  }, []);

  const handleRotate = useCallback(
    (deltaRadians) => {
      const adjustedDelta = deltaRadians * getGestureSensitivityMultiplier(dataFormat);
      setGestureDirection(adjustedDelta >= 0 ? 1 : -1);
      setAdjustment((prev) => ({ ...prev, rotationY: prev.rotationY + adjustedDelta }));
    },
    [dataFormat],
  );

  const handleVertical = useCallback(
    (deltaY) => {
      // 画面上で指を上に動かす(deltaYが負)ほど、3Dデータを上に持ち上げる
      const verticalDelta =
        -deltaY * VERTICAL_METERS_PER_PIXEL * getGestureSensitivityMultiplier(dataFormat);
      setGestureDirection(verticalDelta >= 0 ? 1 : -1);
      setAdjustment((prev) => ({ ...prev, y: prev.y + verticalDelta }));
    },
    [dataFormat],
  );

  const handleResetAdjustment = () => setAdjustment(DEFAULT_ADJUSTMENT);

  const handleFlipVertical = () => {
    setAdjustment((prev) => ({ ...prev, rotationX: prev.rotationX + Math.PI }));
  };

  const handleVertexColorDetected = useCallback((detected) => {
    setColorInfo(detected ? "original" : "gradient");
  }, []);

  const handleSplatLoaded = useCallback(() => {
    // Gaussian Splat(.spz等)はスプラットごとにRGBAを保持しているため常に元データの色になる
    setColorInfo("original");
  }, []);

  const gestureSurfaceRef = useArGestureControls({
    enabled: cameraStream.isActive && arSubMode === "fine-tune" && isAdjustMode,
    onScale: handleScale,
    onRotate: handleRotate,
    onVertical: handleVertical,
    onGestureModeChange: handleGestureModeChange,
  });

  // 設置場所確定時の高度（デバイスの高度）に、微調整の上下オフセットを加えたものを
  // 最終的な保存用の高度とする。高度自体が取得できていない場合はnullのまま保存する。
  const finalAltitude = useMemo(() => {
    if (!placement || placement.altitude === null || placement.altitude === undefined) {
      return null;
    }
    return placement.altitude + adjustment.y;
  }, [placement, adjustment.y]);

  const handleSave = useCallback(async () => {
    if (!dataFile || !placement) return;
    if (!label.trim()) {
      setLabelError(true);
      setSaveStatus("名前を入力してください");
      return;
    }
    setLabelError(false);

    setIsSaving(true);
    setSaveStatus("アップロード中...");
    try {
      const format = getFileFormat(dataFile);
      const storagePath = `${crypto.randomUUID()}.${format}`;

      const { error: uploadError } = await supabase.storage
        .from("ar-assets")
        .upload(storagePath, dataFile, {
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
        setSaveStatus("モーションファイルをアップロード中...");
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

      setSaveStatus("データを登録中...");
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

      setSaveStatus("配置情報を保存中...");
      const { error: placementError } = await supabase.from("ar_placements").insert({
        data_asset_id: assetRow.id,
        label: label.trim(),
        lat: placement.lat,
        lng: placement.lng,
        altitude: finalAltitude,
        rotation_x: adjustment.rotationX,
        rotation_y: adjustment.rotationY,
        scale: adjustment.scale,
        vertical_offset: adjustment.y,
        preview_storage_path: previewStoragePath,
        decoration_preset_key:
          dataFormat === "image" || dataFormat === "gif" ? decorationPresetKey : null,
        image_effect_key: dataFormat === "image" || dataFormat === "gif" ? imageEffectKey : null,
        motion_preset_key:
          dataFormat === "vrm" && motionSourceMode === "preset" ? motionPresetKey : null,
        motion_asset_id: dataFormat === "vrm" && motionSourceMode === "upload" ? motionAssetId : null,
      });
      if (placementError) throw placementError;

      setSaveStatus("シェアしました");
      setIsSaved(true);
      // 「シェアしました」を一瞬表示してからAR閲覧画面に遷移する
      setTimeout(() => router.push("/ar/view"), 1000);
    } catch (saveError) {
      console.error("AR配置の保存に失敗しました:", saveError);
      setSaveStatus(`シェアに失敗しました: ${saveError.message ?? "不明なエラー"}`);
    } finally {
      setIsSaving(false);
    }
  }, [
    dataFile,
    dataFormat,
    placement,
    adjustment,
    label,
    finalAltitude,
    previewBlob,
    decorationPresetKey,
    imageEffectKey,
    motionSourceMode,
    motionPresetKey,
    motionFile,
    supabase,
    router,
  ]);

  return (
    <div className={styles.wrapper}>
      {step === "upload" && (
        <section className={styles.panel}>
          <h2>3Dデータ・メディアの配置</h2>
          <p>
            点群（.ply）、Gaussian Splat（.spz / .splat / .ksplat / .sog）、
            静止画・GIF（.jpg / .png / .webp / .gif）、VRoid Studioデータ（.vrm）
            から選択してください。設置場所はこのあとカメラを見ながら決めます。
            ファイルを選択しない場合はデモ用の点群で動作確認できます。
          </p>

          <label className={styles.field}>
            データファイル (.ply / .spz / .splat / .ksplat / .sog / .jpg / .png / .webp / .gif / .vrm)
            <input
              type="file"
              // iOSの「ファイル」アプリは、.spz等の独自拡張子だけを指定すると
              // ファイルをグレーアウトして選択できないことがあるため、
              // 汎用バイナリのMIMEタイプ（application/octet-stream）も加えて
              // 選択自体は常にできるようにしている（実際の対応判定はJS側で行う）。
              accept=".ply,.spz,.splat,.ksplat,.sog,.jpg,.jpeg,.png,.webp,.gif,.vrm,application/octet-stream"
              onChange={handleFileChange}
            />
          </label>

          {fileError && <p className={styles.error}>{fileError}</p>}
          {dataFile && <p className={styles.hint}>選択中: {dataFile.name}</p>}

          {(dataFormat === "image" || dataFormat === "gif") && (
            <div className={styles.field}>
              <p>装飾フレーム</p>
              <div className={styles.actions}>
                {DECORATION_OPTIONS.map((option) => (
                  <label key={option.value}>
                    <input
                      type="radio"
                      name="decorationPreset"
                      value={option.value}
                      checked={decorationPresetKey === option.value}
                      onChange={() => setDecorationPresetKey(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>

              <p>エフェクト</p>
              <div className={styles.actions}>
                {IMAGE_EFFECT_OPTIONS.map((option) => (
                  <label key={option.value}>
                    <input
                      type="radio"
                      name="imageEffect"
                      value={option.value}
                      checked={imageEffectKey === option.value}
                      onChange={() => setImageEffectKey(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {dataFormat === "vrm" && (
            <div className={styles.field}>
              <p>モーション</p>
              <div className={styles.actions}>
                <label>
                  <input
                    type="radio"
                    name="motionSourceMode"
                    value="preset"
                    checked={motionSourceMode === "preset"}
                    onChange={() => setMotionSourceMode("preset")}
                  />
                  定型モーションを使う
                </label>
                <label>
                  <input
                    type="radio"
                    name="motionSourceMode"
                    value="upload"
                    checked={motionSourceMode === "upload"}
                    onChange={() => setMotionSourceMode("upload")}
                  />
                  モーションファイルをアップロードする
                </label>
              </div>

              {motionSourceMode === "preset" ? (
                <div className={styles.actions}>
                  {MOTION_PRESET_OPTIONS.map((option) => (
                    <label key={option.value}>
                      <input
                        type="radio"
                        name="motionPreset"
                        value={option.value}
                        checked={motionPresetKey === option.value}
                        onChange={() => setMotionPresetKey(option.value)}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              ) : (
                <label className={styles.field}>
                  モーションファイル (.vrma)
                  <input type="file" accept=".vrma" onChange={handleMotionFileChange} />
                </label>
              )}

              {motionFileError && <p className={styles.error}>{motionFileError}</p>}
              {motionSourceMode === "upload" && motionFile && (
                <p className={styles.hint}>選択中: {motionFile.name}</p>
              )}
            </div>
          )}

          <div className={styles.actions}>
            <button type="button" onClick={handleProceedToAr} disabled={!!fileError}>
              ARの設置に進む
            </button>
          </div>
        </section>
      )}

      {step === "ar" && (
        <section className={styles.arView}>
          {/* isActiveに関わらず常にマウントしておく。カメラ開始時にvideo要素が
              まだ存在しないとストリームを紐付けられず、映像が真っ黒になるため。 */}
          <CameraBackground videoRef={cameraStream.videoRef} />

          <button type="button" className={styles.backButton} onClick={handleBackToUpload}>
            ← 戻る
          </button>

          {cameraStream.isActive && (
            <>
              <ARScene
                orientation={deviceOrientation.orientation}
                userPosition={frozenUserPosition ?? geolocation.position}
                targetPosition={placement}
                dataUrl={dataUrl}
                dataFormat={dataFormat}
                splatFileType={splatFileType}
                adjustment={adjustment}
                arSubMode={arSubMode}
                aimPointRef={aimPointRef}
                activeGesture={activeGesture}
                gestureDirection={gestureDirection}
                onVertexColorDetected={handleVertexColorDetected}
                onSplatLoaded={handleSplatLoaded}
                onCanvasReady={(canvas) => {
                  arCanvasRef.current = canvas;
                }}
                decorationPresetKey={decorationPresetKey}
                imageEffectKey={imageEffectKey}
                motionPresetKey={motionSourceMode === "preset" ? motionPresetKey : null}
                motionAssetUrl={motionSourceMode === "upload" ? motionFileUrl : null}
              />

              {arSubMode === "fine-tune" && (
                <div ref={gestureSurfaceRef} className={styles.gestureSurface} />
              )}

              <div className={styles.topOverlay}>
                {arSubMode === "aiming" ? (
                  <>
                    <div className={styles.adjustToolbar}>
                      <button type="button" onClick={handleAimPlace} disabled={!geolocation.position}>
                        ここに配置
                      </button>
                    </div>
                    <p className={styles.adjustHint}>
                      スマホを動かして3Dデータを置きたい場所に重ね、「ここに配置」をタップ
                    </p>
                  </>
                ) : (
                  <>
                    <div className={styles.adjustToolbar}>
                      <button
                        type="button"
                        className={isAdjustMode ? styles.isActive : ""}
                        onClick={() => setIsAdjustMode((current) => !current)}
                      >
                        配置調整: {isAdjustMode ? "ON" : "OFF"}
                      </button>
                      <button type="button" onClick={handleFlipVertical}>
                        上下反転
                      </button>
                      <button type="button" onClick={handleResetAdjustment}>
                        調整をリセット
                      </button>
                      <button type="button" onClick={handleBackToAiming}>
                        大まかな位置合わせに戻る
                      </button>
                      <button type="button" className={styles.isActive} onClick={handleProceedToPost}>
                        次へ（投稿内容を入力）
                      </button>
                    </div>

                    {isAdjustMode && (
                      <p className={styles.adjustHint}>
                        2本指ひねりで回転 ・ 2本指を上下にスライドで上下移動 ・ ピンチで拡大縮小
                      </p>
                    )}

                    {dataUrl && colorInfo && (
                      <p className={styles.colorInfo}>
                        {colorInfo === "original"
                          ? "点群の色: 元データの色を表示中"
                          : "点群の色: 色情報が無いため高さでグラデーション表示中"}
                      </p>
                    )}
                  </>
                )}
              </div>

              <CompassHint
                userPosition={geolocation.position}
                targetPosition={placement}
                deviceHeading={deviceHeading}
              />
            </>
          )}

          {!cameraStream.isActive && (
            <div className={`${styles.panel} ${styles.panelOverlay}`}>
              <p>
                カメラ・位置情報・端末の向きへのアクセスを許可してARを開始します。
                （iOSでは許可ダイアログが表示されます）
              </p>
              <button type="button" onClick={handleStartAr}>
                ARを開始
              </button>
              {cameraStream.error && (
                <p className={styles.error}>カメラエラー: {cameraStream.error.message}</p>
              )}
              {deviceOrientation.permissionState === "denied" && (
                <p className={styles.error}>
                  端末の向きへのアクセスが拒否されました。設定から許可してください。
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {step === "post" && (
        <section className={`${styles.panel} ${styles.panelWide}`}>
          <div className={styles.confirmDetails}>
            <button type="button" className={styles.backLink} onClick={handleBackToAr}>
              ← 戻る
            </button>
            <h2>新規投稿</h2>
            <PlacementLocationMap userPosition={frozenUserPosition ?? geolocation.position} targetPosition={placement} />

            {placement && (
              <p className={styles.hint}>
                緯度 {placement.lat.toFixed(6)}　経度 {placement.lng.toFixed(6)}
                　高度{" "}
                {finalAltitude === null ? "取得できませんでした" : `約${finalAltitude.toFixed(1)}m`}
              </p>
            )}

            {previewUrl && (
              <div className={styles.field}>
                プレビュー画像
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt="設置プレビュー" className={styles.previewImage} />
              </div>
            )}

            <label className={styles.field}>
              名前（必須）
              <input
                type="text"
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  if (event.target.value.trim()) setLabelError(false);
                }}
                placeholder="例: 庭のモニュメント"
                required
              />
              {labelError && <span className={styles.error}>名前を入力してください</span>}
            </label>

            <div className={styles.saveSection}>
              <button
                type="button"
                className={styles.saveButton}
                onClick={handleSave}
                disabled={
                  isSaving ||
                  !dataFile ||
                  !placement ||
                  !label.trim() ||
                  (dataFormat === "vrm" && motionSourceMode === "upload" && !motionFile)
                }
              >
                {isSaving ? "シェア中..." : "シェア"}
              </button>
              {saveStatus && (
                <span className={isSaved ? styles.saveStatusSuccess : styles.saveStatus}>
                  {saveStatus}
                </span>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
