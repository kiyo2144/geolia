"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FILE_SIZE_LIMITS_BYTES,
  FILE_SIZE_LIMIT_LABELS,
  getDataFormat,
  getFileFormat,
  SPLAT_FILE_TYPE_BY_EXTENSION,
} from "../ar/_shared/lib/dataFormat";
import { saveArPlacement } from "../ar/_shared/lib/saveArPlacement";

const DEFAULT_ADJUSTMENT = { y: 0, rotationX: 0, rotationY: 0, scale: 1 };
// カメラで狙い撃ちする代わりに、プレイヤーの正面この距離(m)にプレビューを表示する。
// 近すぎると、静止画・GIFのような薄い平面を見下ろした際にほぼ真横（板の厚み側）
// からの視点になり、実質的に見えなくなってしまうため、十分な距離を確保する。
export const PLACEMENT_AHEAD_METERS = 3;
const ROTATE_STEP_RADIANS = Math.PI / 12; // 15度（ボタン用）
const ROTATE_DRAG_TO_RADIANS = 0.012; // ドラッグ1pxあたりの回転量
const HEIGHT_STEP_METERS = 0.2; // ボタン用
const HEIGHT_DRAG_TO_METERS = 0.01; // ドラッグ1pxあたりの高さ変化量
const SCALE_STEP_RATIO = 1.15; // ボタン・ホイール用
const MIN_SCALE = 0.05;
const MAX_SCALE = 50;
// このフォーマットは「正面から見る」ものなので、位置決め中は常にプレイヤーの方を向かせる
// （向いている方向によって裏側が見えて上下逆に見える、といった見え方のばらつきを防ぐ）
const BILLBOARD_FORMATS = new Set(["image", "gif"]);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * 一人称視点画面から、カメラを使わずにAR配置を新規登録するための状態・操作をまとめたフック。
 * 位置(緯度経度)は「プレイヤーの現在地の少し正面」、またはサブマップをクリックして選んだ
 * 地点を候補地点として使い、高度は標高タイルの値を基準にする。
 *
 * step: 'select'(データ選択) -> 'aiming'(歩く、またはサブマップクリックで位置を決める) ->
 *       'adjust'(回転・高さ・拡大縮小の微調整) -> 'post'(名前を入力して保存)
 */
export function useDesktopArPlacement({
  project,
  sampleElevation,
  minElevation,
  playerStateRef,
  lookAtRequestRef,
  supabase,
  onSaved,
}) {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState("select");
  const [dataFile, setDataFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [adjustment, setAdjustment] = useState(DEFAULT_ADJUSTMENT);
  const [isAdjustMode, setIsAdjustMode] = useState(true);
  const [previewBlob, setPreviewBlob] = useState(null);
  const [decorationPresetKey, setDecorationPresetKey] = useState("none");
  const [imageEffectKey, setImageEffectKey] = useState("none");
  // サブマップをクリックして明示的に選んだ候補地点（未クリックならnullで、
  // プレイヤーの正面に追従する挙動にフォールバックする）
  const [aimLngLat, setAimLngLat] = useState(null);
  const [confirmedLngLat, setConfirmedLngLat] = useState(null);
  const [confirmedGroundAltitude, setConfirmedGroundAltitude] = useState(null);
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  // 位置調整中、今どこに（緯度経度・高度）表示されているかを画面に出すための値。
  // 毎フレーム更新するとReactの再レンダーが多発するため、Canvas側はrefに書き込むだけにして
  // (livePositionRef)、パネル側が一定間隔でポーリングしてlivePositionへ反映する。
  const livePositionRef = useRef(null);
  const [livePosition, setLivePosition] = useState(null);
  useEffect(() => {
    if (!active) return undefined;
    const interval = setInterval(() => {
      setLivePosition(livePositionRef.current ? { ...livePositionRef.current } : null);
    }, 200);
    return () => clearInterval(interval);
  }, [active]);

  const dataFormat = useMemo(() => getDataFormat(dataFile), [dataFile]);
  const splatFileType = useMemo(
    () => (dataFormat === "splat" ? SPLAT_FILE_TYPE_BY_EXTENSION[getFileFormat(dataFile)] : undefined),
    [dataFormat, dataFile],
  );
  const dataUrl = useMemo(() => (dataFile ? URL.createObjectURL(dataFile) : null), [dataFile]);
  useEffect(() => {
    return () => {
      if (dataUrl) URL.revokeObjectURL(dataUrl);
    };
  }, [dataUrl]);

  const reset = useCallback(() => {
    setStep("select");
    setDataFile(null);
    setFileError(null);
    setAdjustment(DEFAULT_ADJUSTMENT);
    setIsAdjustMode(true);
    setPreviewBlob(null);
    setDecorationPresetKey("none");
    setImageEffectKey("none");
    setAimLngLat(null);
    setConfirmedLngLat(null);
    setConfirmedGroundAltitude(null);
    setLabel("");
    setLabelError(false);
    setSaveStatus("");
    livePositionRef.current = null;
    setLivePosition(null);
  }, []);

  const open = useCallback(() => {
    reset();
    setActive(true);
  }, [reset]);

  const close = useCallback(() => {
    setActive(false);
    reset();
  }, [reset]);

  const handleFileChange = useCallback((event) => {
    const file = event.target.files?.[0] ?? null;
    if (file) {
      const format = getDataFormat(file);
      if (!format) {
        setFileError("対応していないファイル形式です");
        setDataFile(null);
        event.target.value = "";
        return;
      }
      if (file.size > FILE_SIZE_LIMITS_BYTES[format]) {
        setFileError(`ファイルサイズが上限（${FILE_SIZE_LIMIT_LABELS[format]}）を超えています`);
        setDataFile(null);
        event.target.value = "";
        return;
      }
    }
    setFileError(null);
    setDataFile(file);
    setPreviewBlob(null);
    setDecorationPresetKey("none");
    setImageEffectKey("none");
  }, []);

  // 静止画・GIFはそのままサムネイルとして使えるため、選択され次第自動でプレビューを生成する
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

  const proceedToAiming = useCallback(() => {
    if (!dataFile) return;
    setAimLngLat(null);
    setStep("aiming");
  }, [dataFile]);

  // 現在の「正面の候補地点」の緯度経度を求める（プレビュー位置の計算と同じ式）
  const computeAheadLngLat = useCallback(() => {
    const player = playerStateRef.current;
    const forwardX = -Math.sin(player.yaw);
    const forwardZ = -Math.cos(player.yaw);
    const x = player.x + forwardX * PLACEMENT_AHEAD_METERS;
    const z = player.z + forwardZ * PLACEMENT_AHEAD_METERS;
    return project.unproject(x, -z);
  }, [playerStateRef, project]);

  // サブマップクリックで候補地点を明示的に指定する
  const pickAimPosition = useCallback((lngLat) => {
    setAimLngLat(lngLat);
  }, []);

  const confirmPosition = useCallback(() => {
    const { lng, lat } = aimLngLat ?? computeAheadLngLat();
    const projected = project(lng, lat);
    const objX = projected.x;
    const objZ = -projected.y;
    const groundElevation = sampleElevation(lng, lat);

    // 画像・GIFは「正面から見る」ものなので、確定した瞬間にプレイヤーの方を
    // 向いた状態を初期値にする（そこから回転ボタン／ドラッグで自由に変更できる）。
    let initialRotationY = 0;
    if (BILLBOARD_FORMATS.has(dataFormat)) {
      const player = playerStateRef.current;
      const dx = player.x - objX;
      const dz = player.z - objZ;
      initialRotationY = Math.atan2(dx, dz);
    }

    setConfirmedLngLat({ lng, lat });
    setConfirmedGroundAltitude(groundElevation);
    setAdjustment({ ...DEFAULT_ADJUSTMENT, rotationY: initialRotationY });
    setStep("adjust");

    // 確定した瞬間、その場所を振り向いて見えるようにする（見つからず調整できない、を防ぐ）
    if (lookAtRequestRef) {
      lookAtRequestRef.current = { x: objX, z: objZ, y: groundElevation - minElevation };
    }
  }, [aimLngLat, computeAheadLngLat, dataFormat, lookAtRequestRef, minElevation, playerStateRef, project, sampleElevation]);

  const backToAiming = useCallback(() => {
    setStep("aiming");
  }, []);

  const backToSelect = useCallback(() => {
    setStep("select");
  }, []);

  const backToAdjust = useCallback(() => {
    setStep("adjust");
  }, []);

  const rotate = useCallback((direction) => {
    setAdjustment((prev) => ({ ...prev, rotationY: prev.rotationY + direction * ROTATE_STEP_RADIANS }));
  }, []);

  const rotateByDelta = useCallback((deltaPixels) => {
    setAdjustment((prev) => ({ ...prev, rotationY: prev.rotationY + deltaPixels * ROTATE_DRAG_TO_RADIANS }));
  }, []);

  const changeScale = useCallback((direction) => {
    setAdjustment((prev) => ({
      ...prev,
      scale: clamp(direction > 0 ? prev.scale * SCALE_STEP_RATIO : prev.scale / SCALE_STEP_RATIO, MIN_SCALE, MAX_SCALE),
    }));
  }, []);

  const changeHeight = useCallback((direction) => {
    setAdjustment((prev) => ({ ...prev, y: prev.y + direction * HEIGHT_STEP_METERS }));
  }, []);

  const changeHeightByDelta = useCallback((deltaPixels) => {
    setAdjustment((prev) => ({ ...prev, y: prev.y + deltaPixels * HEIGHT_DRAG_TO_METERS }));
  }, []);

  const flipVertical = useCallback(() => {
    setAdjustment((prev) => ({ ...prev, rotationX: prev.rotationX + Math.PI }));
  }, []);

  const resetAdjustment = useCallback(() => setAdjustment(DEFAULT_ADJUSTMENT), []);

  const proceedToPost = useCallback(() => setStep("post"), []);

  const finalAltitude = useMemo(() => {
    if (confirmedGroundAltitude === null) return null;
    return confirmedGroundAltitude + adjustment.y;
  }, [confirmedGroundAltitude, adjustment.y]);

  const save = useCallback(async () => {
    if (!dataFile || !confirmedLngLat) return;
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
        lat: confirmedLngLat.lat,
        lng: confirmedLngLat.lng,
        altitude: finalAltitude,
        rotationX: adjustment.rotationX,
        rotationY: adjustment.rotationY,
        scale: adjustment.scale,
        verticalOffset: adjustment.y,
        previewBlob,
        decorationPresetKey,
        imageEffectKey,
        motionSourceMode: "preset",
        motionPresetKey: "idle",
        motionFile: null,
        onStatus: setSaveStatus,
      });
      setSaveStatus("シェアしました");
      await onSaved?.();
      // 「シェアしました」を一瞬表示してから閉じ、一人称視点にそのまま戻す
      setTimeout(() => close(), 600);
    } catch (saveError) {
      console.error("AR配置の保存に失敗しました:", saveError);
      setSaveStatus(`シェアに失敗しました: ${saveError.message ?? "不明なエラー"}`);
    } finally {
      setIsSaving(false);
    }
  }, [
    dataFile,
    dataFormat,
    confirmedLngLat,
    label,
    finalAltitude,
    adjustment,
    previewBlob,
    decorationPresetKey,
    imageEffectKey,
    supabase,
    onSaved,
    close,
  ]);

  return {
    active,
    open,
    close,
    step,
    dataFile,
    dataFormat,
    splatFileType,
    dataUrl,
    fileError,
    handleFileChange,
    proceedToAiming,
    aimLngLat,
    pickAimPosition,
    confirmPosition,
    backToAiming,
    backToSelect,
    backToAdjust,
    adjustment,
    isAdjustMode,
    setIsAdjustMode,
    rotate,
    rotateByDelta,
    changeScale,
    changeHeight,
    changeHeightByDelta,
    flipVertical,
    resetAdjustment,
    proceedToPost,
    previewBlob,
    setPreviewBlob,
    decorationPresetKey,
    setDecorationPresetKey,
    imageEffectKey,
    setImageEffectKey,
    confirmedLngLat,
    finalAltitude,
    livePositionRef,
    livePosition,
    label,
    setLabel,
    labelError,
    isSaving,
    saveStatus,
    save,
  };
}
