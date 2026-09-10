"use client";

import { useCallback, useState } from "react";
import { updateArPlacement } from "../ar/_shared/lib/saveArPlacement";

const ROTATE_STEP_RADIANS = Math.PI / 12; // 15度（ボタン用）
const ROTATE_DRAG_TO_RADIANS = 0.012; // ドラッグ1pxあたりの回転量
const HEIGHT_STEP_METERS = 0.2; // ボタン用
const HEIGHT_DRAG_TO_METERS = 0.01; // ドラッグ1pxあたりの高さ変化量
const SCALE_STEP_RATIO = 1.15;
const MIN_SCALE = 0.05;
const MAX_SCALE = 50;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * 一人称視点画面から、既存のAR配置の向き・高さ・拡大縮小・名前をその場で編集する
 * ための状態・操作をまとめたフック。ファイル自体の差し替えは対象外（位置・見た目の
 * 微調整のみ）。useDesktopArPlacementの「調整」ステップと同じ操作感になるよう、
 * 回転・高さの計算式を揃えている。
 */
export function useArPlacementEdit({ supabase, onSaved }) {
  const [editingPlacement, setEditingPlacement] = useState(null);
  const [adjustment, setAdjustment] = useState({ y: 0, rotationX: 0, rotationY: 0, scale: 1 });
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState(false);
  const [isAdjustMode, setIsAdjustMode] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  const open = useCallback((placement) => {
    // altitude(絶対値) = 設置時点の地表面 + vertical_offset という関係を使い、
    // 編集開始時点の「地表面の高さ」を逆算しておく（高さ調整の基準点にする）。
    const groundElevation = (placement.altitude ?? 0) - (placement.vertical_offset ?? 0);
    setEditingPlacement({ ...placement, groundElevation });
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
  }, []);

  const close = useCallback(() => {
    setEditingPlacement(null);
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

  const resetAdjustment = useCallback(() => {
    if (!editingPlacement) return;
    setAdjustment({
      y: editingPlacement.vertical_offset ?? 0,
      rotationX: editingPlacement.rotation_x ?? 0,
      rotationY: editingPlacement.rotation_y ?? 0,
      scale: editingPlacement.scale ?? 1,
    });
  }, [editingPlacement]);

  const save = useCallback(async () => {
    if (!editingPlacement) return;
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
        lat: editingPlacement.lat,
        lng: editingPlacement.lng,
        altitude: editingPlacement.groundElevation + adjustment.y,
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
  }, [editingPlacement, label, adjustment, supabase, onSaved, close]);

  return {
    editingPlacement,
    open,
    close,
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
