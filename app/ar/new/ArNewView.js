"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ARScene } from "../_shared/components/ARScene";
import { CameraBackground } from "../_shared/components/CameraBackground";
import { CompassHint } from "../_shared/components/CompassHint";
import { ThumbnailPreviewCapture } from "../_shared/components/ThumbnailPreviewCapture";
import { useArGestureControls } from "../_shared/hooks/useArGestureControls";
import { useCameraStream } from "../_shared/hooks/useCameraStream";
import { useDeviceOrientation } from "../_shared/hooks/useDeviceOrientation";
import { useGeolocation } from "../_shared/hooks/useGeolocation";
import { localMetersToLatLng } from "../../_shared/lib/geoMath";
import { PlacementLocationMap } from "../../_shared/components/PlacementLocationMap";
import { createElevationSampler } from "../../map/mapMeshBuilders";
import {
  DECORATION_OPTIONS,
  FILE_SIZE_LIMITS_BYTES,
  FILE_SIZE_LIMIT_LABELS,
  getDataFormat,
  getFileFormat,
  IMAGE_EFFECT_OPTIONS,
  SPLAT_FILE_TYPE_BY_EXTENSION,
} from "../_shared/lib/dataFormat";
import { saveArPlacement } from "../_shared/lib/saveArPlacement";
import styles from "./ArNewView.module.css";

// 標高タイルサンプラーを取得する範囲（度）。DEM_TILE_ZOOMのタイル1枚で十分覆える広さ。
const ELEVATION_SAMPLER_MARGIN_DEGREES = 0.003;

// 設置面が標高タイルの高度にこれだけ近づいたら、警告表示を出すマージン。
// GPSの高度誤差は電波状況に左右され、屋内などGPS精度(accuracy)が悪い状況では
// 標高タイルとの差異が数m以上になることがある一方、屋外の精度の良い状況では
// 誤差はそれほど大きくない（実機確認）。固定値ではなく、その時点のGPS精度・
// 高度のブレ（実機確認: accuracyが良くてもブレが大きいケースがあった）の
// どちらか大きい方に応じてマージンを動的に決める。
const GROUND_WARNING_MARGIN_MIN_METERS = 1.5;
const GROUND_WARNING_MARGIN_MAX_METERS = 8;
// GPSのaccuracy(誤差半径,m)に対してこの倍率でマージンを取る
const GROUND_WARNING_ACCURACY_FACTOR = 0.5;
// 高度のブレ（標準偏差,m）に対してこの倍率でマージンを取る
const GROUND_WARNING_JITTER_FACTOR = 2;

function computeGroundWarningMargin(accuracy, altitudeJitter) {
  const accuracyMargin = accuracy === null || accuracy === undefined ? 0 : accuracy * GROUND_WARNING_ACCURACY_FACTOR;
  const jitterMargin =
    altitudeJitter === null || altitudeJitter === undefined ? 0 : altitudeJitter * GROUND_WARNING_JITTER_FACTOR;
  return Math.min(
    Math.max(accuracyMargin, jitterMargin, GROUND_WARNING_MARGIN_MIN_METERS),
    GROUND_WARNING_MARGIN_MAX_METERS,
  );
}

// x/z(水平位置)は「狙い撃ち配置」で決まるため、微調整では上下移動・回転・拡大縮小のみ扱う
const DEFAULT_ADJUSTMENT = { y: 0, rotationX: 0, rotationY: 0, scale: 1 };

// 2本指を上下にスライドした時、1pxあたりどれだけ高さ(メートル)を動かすか。
// 画面の半分〜全体を一気にスワイプしたときの変化量が1〜2m程度に収まるくらいを目安にしている。
const VERTICAL_METERS_PER_PIXEL = 0.002;
const MIN_SCALE = 0.05;
const MAX_SCALE = 50;

// タッチイベント1回あたりで高さを動かせる量の上限(メートル)。指の本数の変化や
// 端末側のタッチ座標の乱れなどで1回のイベントに異常に大きいdeltaYが来た場合に、
// 高さがその分だけ一気に(カメラ映像外の上空まで)吹っ飛ばないよう、常に小刻みにしか
// 動かないようにするための安全弁。通常のスワイプ操作では毎フレームの移動量は
// これよりずっと小さいため、体感の操作感には影響しない。
const MAX_VERTICAL_DELTA_PER_EVENT_METERS = 0.3;

// 地面(groundLocalY)からこの高さまでしか持ち上げられないようにする上限。
// これが無いと、繰り返しスワイプすればどこまでも上げられてしまい、カメラの
// 視野から外れて見えなくなる（地面より下に置けないのと対称の安全策）。
const MAX_HEIGHT_ABOVE_GROUND_METERS = 30;

// GPS高度の信頼性が低いと判断したときに、代わりに使う「地面から持ち上げて構えている
// 高さ」の目安（人がスマホを構える高さの概算）。屋内（特にコンクリート造）ではGPS高度が
// 反射・遮蔽の影響で数十m単位で狂うことがあり、その状態のGPS高度をそのまま設置面の
// 基準にすると、実際にはあり得ない高さに地面下限が来てしまう。
const ASSUMED_HAND_HEIGHT_METERS = 1;

// 静止画・GIFは平面（板状）で表示されるため、点群等に比べて同じ回転・上下移動量でも
// 見た目の変化が乏しく操作しにくい。データ種別ごとに回転・上下移動の感度を補正する。
const GESTURE_SENSITIVITY_MULTIPLIERS = { image: 2.5, gif: 2.5 };
const getGestureSensitivityMultiplier = (dataFormat) =>
  GESTURE_SENSITIVITY_MULTIPLIERS[dataFormat] ?? 1;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// VRM定型モーションの初期セット（要件定義 docs/requirements.md 4.1.3章）
const MOTION_PRESET_OPTIONS = [
  { value: "idle", label: "待機" },
  { value: "wave", label: "手を振る" },
  { value: "bow", label: "お辞儀" },
  { value: "jump", label: "ジャンプ" },
];

const MOTION_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const MOTION_FILE_SIZE_LIMIT_LABEL = "10MB";

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
  // 設置場所(lat/lng)における標高タイルの高度。設置面がこれを下回らないようにする
  const [groundElevation, setGroundElevation] = useState(null);
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
  // データ選択時に撮影する、画像・3Dモデル単体のプレビュー画像（配置一覧等のサムネイル用）
  const [previewBlob, setPreviewBlob] = useState(null);

  const geolocation = useGeolocation({ watch: true });
  const deviceOrientation = useDeviceOrientation();
  const cameraStream = useCameraStream();

  // 狙い撃ちモードでカメラ正面に表示している地点のローカル座標(east/north)。
  // Canvas内で毎フレーム更新され、「ここに配置」ボタン押下時に読み取る。
  const aimPointRef = useRef({ east: 0, north: 0 });

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

  // 静止画・GIFはそのままサムネイルとして使えるため、選択され次第自動でプレビューを生成する
  // （3Dモデルはアングルを選べる<ThumbnailPreviewCapture>から手動で撮影する）。
  useEffect(() => {
    if (dataFormat !== "image" && dataFormat !== "gif") return;
    if (!dataUrl) return;

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (!cancelled && blob) setPreviewBlob(blob);
        },
        "image/jpeg",
        0.85,
      );
    };
    image.src = dataUrl;

    return () => {
      cancelled = true;
    };
  }, [dataFormat, dataUrl]);

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
        setPreviewBlob(null);
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
        setPreviewBlob(null);
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
    setPreviewBlob(null);
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
    setPlacement({
      ...confirmedLatLng,
      altitude: geolocation.position.altitude,
      accuracy: geolocation.position.accuracy,
      altitudeJitter: geolocation.getAltitudeJitter(),
    });
    setFrozenUserPosition(geolocation.position);
    setAdjustment(DEFAULT_ADJUSTMENT);
    setArSubMode("fine-tune");
    setIsSaved(false);

    setGroundElevation(null);
    const margin = ELEVATION_SAMPLER_MARGIN_DEGREES;
    createElevationSampler({
      minLng: confirmedLatLng.lng - margin,
      maxLng: confirmedLatLng.lng + margin,
      minLat: confirmedLatLng.lat - margin,
      maxLat: confirmedLatLng.lat + margin,
    })
      .then((sampler) => {
        setGroundElevation(sampler(confirmedLatLng.lng, confirmedLatLng.lat));
      })
      .catch(() => {
        // 標高タイルが取得できなくても設置自体は継続できるようにする(警告表示のみ諦める)
      });
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

  // その時点のGPS精度・高度のブレに応じた警告マージン（精度が良く安定しているほど
  // 狭く、悪い・不安定なほど広くなる）
  const groundWarningMargin = useMemo(
    () => computeGroundWarningMargin(placement?.accuracy, placement?.altitudeJitter),
    [placement],
  );

  // マージンが上限(GROUND_WARNING_MARGIN_MAX_METERS)まで振り切れているときは、
  // 「多少ブレている」ではなく「GPS高度そのものが信用できない」状態とみなす
  // （屋内などでGPS高度が数十m単位で狂うケースがこれに該当する）。
  const isAltitudeUnreliable = groundWarningMargin >= GROUND_WARNING_MARGIN_MAX_METERS;

  // 設置面の計算に使う高度。GPS高度が信用できない場合は、実際のGPS高度ではなく
  // 「標高タイルの地面 + 人がスマホを構える高さの目安」を代わりに使う。
  const effectiveAltitude = useMemo(() => {
    if (!placement || placement.altitude === null || placement.altitude === undefined) return null;
    if (groundElevation === null) return placement.altitude;
    return isAltitudeUnreliable ? groundElevation + ASSUMED_HAND_HEIGHT_METERS : placement.altitude;
  }, [placement, groundElevation, isAltitudeUnreliable]);

  // 設置面(adjustment.y)の下限。effectiveAltitude + y が標高タイルの高度を
  // 下回らないよう、対応するローカルY座標をあらかじめ求めておく。
  const groundLocalY = useMemo(() => {
    if (groundElevation === null || effectiveAltitude === null) return null;
    return groundElevation - effectiveAltitude;
  }, [groundElevation, effectiveAltitude]);

  const handleVertical = useCallback(
    (deltaY) => {
      // 画面上で指を上に動かす(deltaYが負)ほど、3Dデータを上に持ち上げる
      // 上下移動は画像・GIFでも位置のずれがそのまま見えるため、回転と違って
      // データ種別による感度補正(GESTURE_SENSITIVITY_MULTIPLIERS)はかけない。
      const rawVerticalDelta = -deltaY * VERTICAL_METERS_PER_PIXEL;
      const verticalDelta = clamp(
        rawVerticalDelta,
        -MAX_VERTICAL_DELTA_PER_EVENT_METERS,
        MAX_VERTICAL_DELTA_PER_EVENT_METERS,
      );
      setGestureDirection(verticalDelta >= 0 ? 1 : -1);
      setAdjustment((prev) => {
        const nextY = prev.y + verticalDelta;
        const desiredY =
          groundLocalY === null
            ? nextY
            : clamp(nextY, groundLocalY, groundLocalY + MAX_HEIGHT_ABOVE_GROUND_METERS);
        // 地面の高さ(groundLocalY)はGPSの高度と標高タイルの差から計算しているため、
        // GPSの高度が不正確だと大きくずれることがある。そのタイミングでdesiredYが
        // 現在地から大きく離れていても、地面クランプでその場に一瞬で飛ばすのではなく、
        // 他の高さ変化と同様に1回のイベントで動ける量までしか動かさない。
        const step = clamp(
          desiredY - prev.y,
          -MAX_VERTICAL_DELTA_PER_EVENT_METERS,
          MAX_VERTICAL_DELTA_PER_EVENT_METERS,
        );
        return { ...prev, y: prev.y + step };
      });
    },
    [groundLocalY],
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

  // 設置面が標高タイルの高度に近づいている(または下限に達している)かどうか
  const isNearGround = groundLocalY !== null && adjustment.y <= groundLocalY + groundWarningMargin;

  const gestureSurfaceRef = useArGestureControls({
    enabled: cameraStream.isActive && arSubMode === "fine-tune" && isAdjustMode,
    onScale: handleScale,
    onRotate: handleRotate,
    onVertical: handleVertical,
    onGestureModeChange: handleGestureModeChange,
  });

  // 設置場所確定時の高度（GPS高度が信用できる場合はそれ、できない場合は
  // effectiveAltitudeで代替した値）に、微調整の上下オフセットを加えたものを
  // 最終的な保存用の高度とする。高度自体が取得できていない場合はnullのまま保存する。
  const finalAltitude = useMemo(() => {
    if (effectiveAltitude === null) return null;
    return effectiveAltitude + adjustment.y;
  }, [effectiveAltitude, adjustment.y]);

  const handleSave = useCallback(async () => {
    if (!dataFile || !placement) return;
    if (!label.trim()) {
      setLabelError(true);
      setSaveStatus("名前を入力してください");
      return;
    }
    setLabelError(false);

    setIsSaving(true);
    try {
      await saveArPlacement(supabase, {
        dataFile,
        dataFormat,
        label,
        lat: placement.lat,
        lng: placement.lng,
        altitude: finalAltitude,
        rotationX: adjustment.rotationX,
        rotationY: adjustment.rotationY,
        scale: adjustment.scale,
        verticalOffset: adjustment.y,
        previewBlob,
        decorationPresetKey,
        imageEffectKey,
        motionSourceMode,
        motionPresetKey,
        motionFile,
        onStatus: setSaveStatus,
      });

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

          {dataUrl && (dataFormat === "splat" || dataFormat === "ply" || dataFormat === "vrm") && (
            <div className={styles.field}>
              <p>サムネイル（配置一覧などに表示される画像）</p>
              <ThumbnailPreviewCapture
                dataFormat={dataFormat}
                dataUrl={dataUrl}
                splatFileType={splatFileType}
                onCapture={setPreviewBlob}
              />
              {previewUrl ? (
                <p className={styles.hint}>
                  <img src={previewUrl} alt="サムネイルプレビュー" className={styles.thumbnailSmall} />
                  撮影済み
                </p>
              ) : (
                <p className={styles.hint}>まだ撮影されていません（未撮影でも投稿できます）</p>
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
                groundLocalY={groundLocalY}
                showGroundWarning={arSubMode === "fine-tune" && isNearGround}
                onVertexColorDetected={handleVertexColorDetected}
                onSplatLoaded={handleSplatLoaded}
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
                        1本指スワイプで回転（フリックで慣性あり） ・ 2本指を上下にスライドで上下移動 ・ ピンチで拡大縮小
                      </p>
                    )}

                    {/* AR配置予定地点のデバッグ表示（原因切り分けが済んだら削除する） */}
                    {placement && (
                      <p className={styles.adjustHint}>
                        緯度 {placement.lat.toFixed(6)}　経度 {placement.lng.toFixed(6)}
                        　高度{" "}
                        {finalAltitude === null ? "取得できませんでした" : `約${finalAltitude.toFixed(2)}m`}
                        {groundLocalY !== null &&
                          `（地面からの高さ 約${(adjustment.y - groundLocalY).toFixed(2)}m）`}
                      </p>
                    )}

                    {/* GPS高度の信頼性判定のデバッグ表示（原因切り分けが済んだら削除する） */}
                    {placement && (
                      <p className={styles.adjustHint}>
                        生の高度 約{placement.altitude?.toFixed(2) ?? "?"}m　GPS精度 約
                        {placement.accuracy?.toFixed(1) ?? "?"}m　高度のブレ 約
                        {placement.altitudeJitter?.toFixed(2) ?? "?"}m　警告マージン 約
                        {groundWarningMargin.toFixed(2)}m　信頼性低判定:{" "}
                        {isAltitudeUnreliable ? "YES" : "no"}
                      </p>
                    )}

                    {isNearGround && (
                      <p className={styles.groundWarning}>地面より下には設置できません</p>
                    )}

                    {isAltitudeUnreliable && (
                      <p className={styles.groundWarning}>
                        GPSの高度精度が低いため、地面の高さは目安（3Dマップの標高 + 約1m）で計算しています
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
