"use client";

import { useEffect, useRef } from "react";

/**
 * デスクトップAR設置の「配置調整」用マウス操作。
 * 横ドラッグ=回転、縦ドラッグ=高さ、ホイール=拡大縮小。
 * 対象要素はCanvasの上に重ねた透明なオーバーレイ（pointer-events:auto）を想定し、
 * これが手前にあることで一人称視点側の視点回転ドラッグより先にイベントを拾う。
 */
export function useDesktopAdjustGestures({ enabled, onRotateByDelta, onHeightByDelta, onScaleStep }) {
  const targetRef = useRef(null);

  useEffect(() => {
    const el = targetRef.current;
    if (!el || !enabled) return undefined;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const handlePointerDown = (event) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      el.setPointerCapture?.(event.pointerId);
    };
    const handlePointerMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (dx !== 0) onRotateByDelta(dx);
      if (dy !== 0) onHeightByDelta(-dy);
    };
    const handlePointerUp = () => {
      dragging = false;
    };
    const handleWheel = (event) => {
      event.preventDefault();
      onScaleStep(event.deltaY < 0 ? 1 : -1);
    };

    el.addEventListener("pointerdown", handlePointerDown);
    el.addEventListener("pointermove", handlePointerMove);
    el.addEventListener("pointerup", handlePointerUp);
    el.addEventListener("pointerleave", handlePointerUp);
    el.addEventListener("pointercancel", handlePointerUp);
    el.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      el.removeEventListener("pointerdown", handlePointerDown);
      el.removeEventListener("pointermove", handlePointerMove);
      el.removeEventListener("pointerup", handlePointerUp);
      el.removeEventListener("pointerleave", handlePointerUp);
      el.removeEventListener("pointercancel", handlePointerUp);
      el.removeEventListener("wheel", handleWheel);
    };
  }, [enabled, onRotateByDelta, onHeightByDelta, onScaleStep]);

  return targetRef;
}
