"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ARScene } from "../_shared/components/ARScene";
import { CameraBackground } from "../_shared/components/CameraBackground";
import { CompassHint } from "../_shared/components/CompassHint";
import { useArGestureControls } from "../_shared/hooks/useArGestureControls";
import { useCameraStream } from "../_shared/hooks/useCameraStream";
import { useDeviceOrientation } from "../_shared/hooks/useDeviceOrientation";
import { useGeolocation } from "../_shared/hooks/useGeolocation";
import { localMetersToLatLng } from "../_shared/lib/geoMath";
import { PlacementConfirmMap } from "./PlacementConfirmMap";
import styles from "./ArNewView.module.css";

const STEPS = [
  { id: "upload", label: "① データ選択" },
  { id: "ar", label: "② AR配置" },
  { id: "confirm", label: "③ 確認・保存" },
];

// x/z(水平位置)は「狙い撃ち配置」で決まるため、微調整では上下移動・回転・拡大縮小のみ扱う
const DEFAULT_ADJUSTMENT = { y: 0, rotationX: 0, rotationY: 0, scale: 1 };

// 2本指を上下にスライドした時、1pxあたりどれだけ高さ(メートル)を動かすか
const VERTICAL_METERS_PER_PIXEL = 0.01;
const MIN_SCALE = 0.05;
const MAX_SCALE = 50;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// 対応データ種別ごとのファイルサイズ上限（要件定義 docs/requirements.md 4.1.4章）
const SPLAT_EXTENSIONS = ["spz", "splat", "ksplat", "sog"];
const FILE_SIZE_LIMITS_BYTES = { ply: 100 * 1024 * 1024, splat: 50 * 1024 * 1024 };

function getFileFormat(file) {
  if (!file) return null;
  const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : null;
}

// 拡張子から、点群(PLY)として読むかGaussian Splatとして読むかを判定する
function getDataFormat(file) {
  const format = getFileFormat(file);
  if (!format) return null;
  return SPLAT_EXTENSIONS.includes(format) ? "splat" : "ply";
}

function getAssetType(dataFormat) {
  return dataFormat === "splat" ? "gaussian_splat" : "point_cloud";
}

export function ArNewView() {
  const supabase = useMemo(() => createClient(), []);

  const [step, setStep] = useState("upload");
  const [dataFile, setDataFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [placement, setPlacement] = useState(null); // { lat, lng, altitude }
  const [adjustment, setAdjustment] = useState(DEFAULT_ADJUSTMENT);
  const [isAdjustMode, setIsAdjustMode] = useState(true);
  // 'aiming'(狙い撃ちで大まかな位置合わせ) | 'fine-tune'(回転・上下移動などの微調整)
  const [arSubMode, setArSubMode] = useState("aiming");
  // 現在確定しているジェスチャー操作。矢印ギズモの表示に使う。
  const [activeGesture, setActiveGesture] = useState(null);
  const [gestureDirection, setGestureDirection] = useState(0);
  // null | 'original'(元データの色) | 'gradient'(色情報が無く高さで自動着色)
  const [colorInfo, setColorInfo] = useState(null);
  const [label, setLabel] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [isSaved, setIsSaved] = useState(false);

  const geolocation = useGeolocation({ watch: true });
  const deviceOrientation = useDeviceOrientation();
  const cameraStream = useCameraStream();

  // 狙い撃ちモードでカメラ正面に表示している地点のローカル座標(east/north)。
  // Canvas内で毎フレーム更新され、「ここに配置」ボタン押下時に読み取る。
  const aimPointRef = useRef({ east: 0, north: 0 });

  const isConfirmReady = placement !== null;

  const dataFormat = useMemo(() => getDataFormat(dataFile), [dataFile]);

  // アップロードされたファイルから three.js / Spark が読める一時URLを作る
  const dataUrl = useMemo(() => (dataFile ? URL.createObjectURL(dataFile) : null), [dataFile]);

  useEffect(() => {
    return () => {
      if (dataUrl) URL.revokeObjectURL(dataUrl);
    };
  }, [dataUrl]);

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
      const limitBytes = FILE_SIZE_LIMITS_BYTES[format];
      if (file.size > limitBytes) {
        setFileError(
          `ファイルサイズが上限（${format === "ply" ? "100MB" : "50MB"}）を超えています`,
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
    setIsSaved(false);
  };

  const handlePlaceHere = () => {
    if (!geolocation.position) return;
    const { lat, lng, altitude } = geolocation.position;
    setPlacement({ lat, lng, altitude });
    setAdjustment(DEFAULT_ADJUSTMENT);
    setIsSaved(false);
  };

  const handleStartAr = async () => {
    geolocation.start();
    // 既存の設置場所があっても、まずは狙い撃ちモード(画面中央固定)から始める
    setArSubMode("aiming");
    await Promise.all([cameraStream.start(), deviceOrientation.requestPermission()]);
  };

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
    setAdjustment(DEFAULT_ADJUSTMENT);
    setArSubMode("fine-tune");
    setIsSaved(false);
  };

  const handleBackToAiming = () => setArSubMode("aiming");

  const handleGestureModeChange = useCallback((mode) => {
    setActiveGesture(mode);
    if (mode === null) setGestureDirection(0);
  }, []);

  const handleScale = useCallback((ratio) => {
    setGestureDirection(ratio >= 1 ? 1 : -1);
    setAdjustment((prev) => ({ ...prev, scale: clamp(prev.scale * ratio, MIN_SCALE, MAX_SCALE) }));
  }, []);

  const handleRotate = useCallback((deltaRadians) => {
    setGestureDirection(deltaRadians >= 0 ? 1 : -1);
    setAdjustment((prev) => ({ ...prev, rotationY: prev.rotationY + deltaRadians }));
  }, []);

  const handleVertical = useCallback((deltaY) => {
    // 画面上で指を上に動かす(deltaYが負)ほど、3Dデータを上に持ち上げる
    const verticalDelta = -deltaY * VERTICAL_METERS_PER_PIXEL;
    setGestureDirection(verticalDelta >= 0 ? 1 : -1);
    setAdjustment((prev) => ({ ...prev, y: prev.y + verticalDelta }));
  }, []);

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
        label: label.trim() || null,
        lat: placement.lat,
        lng: placement.lng,
        altitude: finalAltitude,
        rotation_x: adjustment.rotationX,
        rotation_y: adjustment.rotationY,
        scale: adjustment.scale,
        vertical_offset: adjustment.y,
      });
      if (placementError) throw placementError;

      setSaveStatus("保存が完了しました");
      setIsSaved(true);
    } catch (saveError) {
      console.error("AR配置の保存に失敗しました:", saveError);
      setSaveStatus(`保存に失敗しました: ${saveError.message ?? "不明なエラー"}`);
    } finally {
      setIsSaving(false);
    }
  }, [dataFile, dataFormat, placement, adjustment, label, finalAltitude, supabase]);

  return (
    <div className={styles.wrapper}>
      <nav className={styles.tabs}>
        {STEPS.map(({ id, label: tabLabel }) => {
          const disabled = id === "confirm" && !isConfirmReady;
          return (
            <button
              key={id}
              type="button"
              className={`${styles.tab} ${step === id ? styles.tabActive : ""}`}
              disabled={disabled}
              onClick={() => setStep(id)}
            >
              {tabLabel}
            </button>
          );
        })}
      </nav>

      {step === "upload" && (
        <section className={styles.panel}>
          <h2>3Dデータの配置</h2>
          <p>
            点群（.ply）またはGaussian Splat（.spz / .splat / .ksplat /
            .sog）データを選択してください。設置場所は「② AR配置」でカメラを見ながら決めます
            （現在地をそのまま使う場合はここで先に記録することもできます）。
            ファイルを選択しない場合はデモ用の点群で動作確認できます。
          </p>

          <label className={styles.field}>
            3Dデータファイル (.ply / .spz / .splat / .ksplat / .sog)
            <input type="file" accept=".ply,.spz,.splat,.ksplat,.sog" onChange={handleFileChange} />
          </label>

          {fileError && <p className={styles.error}>{fileError}</p>}
          {dataFile && <p className={styles.hint}>選択中: {dataFile.name}</p>}

          <div className={styles.actions}>
            <button type="button" onClick={() => geolocation.start()}>
              位置情報の取得を開始
            </button>
            <button type="button" onClick={handlePlaceHere} disabled={!geolocation.position}>
              現在地をこの3Dデータの設置場所にする
            </button>
          </div>

          {geolocation.error && (
            <p className={styles.error}>位置情報エラー: {geolocation.error.message}</p>
          )}

          {geolocation.position && (
            <p className={styles.hint}>
              現在地: {geolocation.position.lat.toFixed(6)}, {geolocation.position.lng.toFixed(6)}
              （精度 約{Math.round(geolocation.position.accuracy)}m）
            </p>
          )}

          {placement && (
            <p className={`${styles.hint} ${styles.hintSuccess}`}>
              設置場所を記録しました: {placement.lat.toFixed(6)}, {placement.lng.toFixed(6)}
            </p>
          )}
        </section>
      )}

      {step === "ar" && (
        <section className={styles.arView}>
          {/* isActiveに関わらず常にマウントしておく。カメラ開始時にvideo要素が
              まだ存在しないとストリームを紐付けられず、映像が真っ黒になるため。 */}
          <CameraBackground videoRef={cameraStream.videoRef} />

          {cameraStream.isActive && (
            <>
              <ARScene
                orientation={deviceOrientation.orientation}
                userPosition={geolocation.position}
                targetPosition={placement}
                dataUrl={dataUrl}
                dataFormat={dataFormat}
                adjustment={adjustment}
                arSubMode={arSubMode}
                aimPointRef={aimPointRef}
                activeGesture={activeGesture}
                gestureDirection={gestureDirection}
                onVertexColorDetected={handleVertexColorDetected}
                onSplatLoaded={handleSplatLoaded}
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

      {step === "confirm" && (
        <section className={`${styles.panel} ${styles.panelWide}`}>
          <div className={styles.confirmDetails}>
            <h2>設置場所の確認・保存</h2>
            <PlacementConfirmMap userPosition={geolocation.position} targetPosition={placement} />

            {placement && (
              <p className={styles.hint}>
                緯度 {placement.lat.toFixed(6)}　経度 {placement.lng.toFixed(6)}
                　高度{" "}
                {finalAltitude === null ? "取得できませんでした" : `約${finalAltitude.toFixed(1)}m`}
              </p>
            )}

            <label className={styles.field}>
              名前（任意）
              <input
                type="text"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="例: 庭のモニュメント"
              />
            </label>

            <div className={styles.saveSection}>
              <button
                type="button"
                className={styles.saveButton}
                onClick={handleSave}
                disabled={isSaving || !dataFile || !placement}
              >
                {isSaving ? "保存中..." : "保存する"}
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
