"use client";

import { useCallback, useMemo, useState } from "react";
import { haversineDistanceMeters } from "../_shared/lib/geoMath";
import { updateArPlacement } from "../ar/_shared/lib/saveArPlacement";

const ROTATE_STEP_RADIANS = Math.PI / 12; // 15度（ボタン用）
const ROTATE_DRAG_TO_RADIANS = 0.012; // ドラッグ1pxあたりの回転量
const HEIGHT_STEP_METERS = 0.2; // ボタン用
const HEIGHT_DRAG_TO_METERS = 0.01; // ドラッグ1pxあたりの高さ変化量
const POSITION_STEP_METERS = 0.5; // 位置移動ボタン1回あたりの移動量
const SCALE_STEP_RATIO = 1.15;
const MIN_SCALE = 0.05;
const MAX_SCALE = 50;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * 一人称視点画面から、既存のAR配置の位置・向き・高さ・拡大縮小・名前をその場で編集する
 * ための状態・操作をまとめたフック。ファイル自体の差し替えは対象外（位置・見た目の
 * 微調整のみ）。useDesktopArPlacementの「調整」ステップと同じ操作感になるよう、
 * 回転・高さの計算式を揃えている。
 *
 * 位置(緯度経度)は、サブマップのクリック、またはボタンによる前後左右の微移動で変更できる。
 * 高さは「地表面からの高さ(adjustment.y)」を保ったまま、移動先の標高に追従する。
 */
export function useArPlacementEdit({
  project,
  sampleElevation,
  boundsMeters,
  playerStateRef,
  supabase,
  onSaved,
}) {
  const [editingPlacement, setEditingPlacement] = useState(null);
  const [position, setPosition] = useState(null); // { lng, lat }（編集中の配置位置）
  const [isPickingPosition, setIsPickingPosition] = useState(false);
  const [adjustment, setAdjustment] = useState({ y: 0, rotationX: 0, rotationY: 0, scale: 1 });
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState(false);
  const [isAdjustMode, setIsAdjustMode] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  const open = useCallback((placement) => {
    // altitude(絶対値) = 設置時点の地表面 + vertical_offset という関係を使い、
    // 編集開始時点の「地表面の高さ」を逆算しておく（高さ調整の基準点にする）。
    // 高度が無い古いデータは、読み込み済みの標高データから補う。
    const groundElevation =
      placement.altitude != null
        ? placement.altitude - (placement.vertical_offset ?? 0)
        : (sampleElevation?.(placement.lng, placement.lat) ?? 0);
    setEditingPlacement({ ...placement, groundElevation });
    setPosition({ lng: placement.lng, lat: placement.lat });
    setIsPickingPosition(false);
    setAdjustment({
      y: placement.vertical_offset ?? 0,
      rotationX: placement.rotation_x ?? 0,
      rotationY: placement.rotation_y ?? 0,
      scale: placement.scale ?? 1,
    });
    setLabel(placement.label ?? "");
    setLabelError(false);
    setIsAdjustMode(true);
    setSaveStatus("");
  }, [sampleElevation]);

  const close = useCallback(() => {
    setEditingPlacement(null);
    setPosition(null);
    setIsPickingPosition(false);
  }, []);

  // 読み込み範囲の外へ出すと、再取得（周辺のAR配置の取得）に含まれず消えて見えてしまうため、
  // サブマップ上の瞬間移動と同じ範囲に収める。
  const clampToBounds = useCallback(
    (lngLat) => {
      if (!project || !boundsMeters) return lngLat;
      const { x, y } = project(lngLat.lng, lngLat.lat);
      const clampedX = clamp(x, -boundsMeters, boundsMeters);
      const clampedY = clamp(y, -boundsMeters, boundsMeters);
      if (clampedX === x && clampedY === y) return lngLat;
      return project.unproject(clampedX, clampedY);
    },
    [project, boundsMeters],
  );

  // サブマップのクリックで、移動先を直接指定する
  const pickPosition = useCallback(
    (lngLat) => {
      setPosition(clampToBounds({ lng: lngLat.lng, lat: lngLat.lat }));
    },
    [clampToBounds],
  );

  // プレイヤーの視線方向を基準に、前後(forward)・左右(right)へ少しずつ動かす。
  // direction: forward=+1(奥へ)/-1(手前へ)、right=+1(右へ)/-1(左へ)
  const nudgePosition = useCallback(
    ({ forward = 0, right = 0 }) => {
      if (!project || !playerStateRef) return;
      setPosition((prev) => {
        if (!prev) return prev;
        const yaw = playerStateRef.current.yaw;
        const forwardMeters = forward * POSITION_STEP_METERS;
        const rightMeters = right * POSITION_STEP_METERS;
        // 一人称視点のカメラ座標系: 前方向=(-sin(yaw), -cos(yaw))(x, z)。z=-北なので
        // 東・北に直すと、前=(-sin, +cos)、右=(+cos, +sin)になる。
        const eastDelta = -Math.sin(yaw) * forwardMeters + Math.cos(yaw) * rightMeters;
        const northDelta = Math.cos(yaw) * forwardMeters + Math.sin(yaw) * rightMeters;
        const current = project(prev.lng, prev.lat);
        return clampToBounds(project.unproject(current.x + eastDelta, current.y + northDelta));
      });
    },
    [project, playerStateRef, clampToBounds],
  );

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

  const resetAdjustment = useCallback(() => {
    if (!editingPlacement) return;
    setPosition({ lng: editingPlacement.lng, lat: editingPlacement.lat });
    setAdjustment({
      y: editingPlacement.vertical_offset ?? 0,
      rotationX: editingPlacement.rotation_x ?? 0,
      rotationY: editingPlacement.rotation_y ?? 0,
      scale: editingPlacement.scale ?? 1,
    });
  }, [editingPlacement]);

  // 移動先の地表面の高さ。元の位置では保存済みの値をそのまま使い、移動した分だけ
  // 標高データ上の高低差を足す（保存時の地表面の取り方が標高データと多少ずれていても、
  // 動かさない限り見た目が変わらないようにするため）。
  const groundElevation = useMemo(() => {
    if (!editingPlacement || !position) return null;
    if (!sampleElevation) return editingPlacement.groundElevation;
    const delta =
      sampleElevation(position.lng, position.lat) -
      sampleElevation(editingPlacement.lng, editingPlacement.lat);
    return editingPlacement.groundElevation + delta;
  }, [editingPlacement, position, sampleElevation]);

  const movedDistanceMeters = useMemo(() => {
    if (!editingPlacement || !position) return 0;
    return haversineDistanceMeters(
      { lat: editingPlacement.lat, lng: editingPlacement.lng },
      { lat: position.lat, lng: position.lng },
    );
  }, [editingPlacement, position]);

  const save = useCallback(async () => {
    if (!editingPlacement || !position || groundElevation === null) return;
    if (!label.trim()) {
      setLabelError(true);
      setSaveStatus("名前を入力してください");
      return;
    }
    setLabelError(false);
    setIsSaving(true);
    try {
      await updateArPlacement(supabase, editingPlacement.id, {
        label,
        lat: position.lat,
        lng: position.lng,
        altitude: groundElevation + adjustment.y,
        rotationX: adjustment.rotationX,
        rotationY: adjustment.rotationY,
        scale: adjustment.scale,
        verticalOffset: adjustment.y,
        onStatus: setSaveStatus,
      });
      setSaveStatus("更新しました");
      await onSaved?.();
      setTimeout(() => close(), 600);
    } catch (saveError) {
      console.error("AR配置の更新に失敗しました:", saveError);
      setSaveStatus(`更新に失敗しました: ${saveError.message ?? "不明なエラー"}`);
    } finally {
      setIsSaving(false);
    }
  }, [editingPlacement, position, groundElevation, label, adjustment, supabase, onSaved, close]);

  return {
    editingPlacement,
    open,
    close,
    position,
    groundElevation,
    movedDistanceMeters,
    isPickingPosition,
    setIsPickingPosition,
    pickPosition,
    nudgePosition,
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
    label,
    setLabel,
    labelError,
    isSaving,
    saveStatus,
    save,
  };
}
