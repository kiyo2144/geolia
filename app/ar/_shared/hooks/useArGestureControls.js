"use client";

import { useEffect, useRef } from "react";

const getTouchDistance = (touches) => {
  const [a, b] = touches;
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
};

const getTouchAngle = (touches) => {
  const [a, b] = touches;
  return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
};

const getTouchMidpointY = (touches) => {
  const [a, b] = touches;
  return (a.clientY + b.clientY) / 2;
};

// 2本指ジェスチャーを「拡大縮小」「回転」「上下移動」のどれか1つに確定するための閾値。
// 複数の意図が混ざって暴れないよう、最初に閾値を超えた操作だけを採用する。
const SCALE_LOG_THRESHOLD = 0.05;
const ROTATE_RADIAN_THRESHOLD = 0.06;
const VERTICAL_PIXEL_THRESHOLD = 10;

/**
 * AR画面上でのタッチ操作を検出するフック。
 * - 2本指ピンチ・ひねり・上下スライドは、最初に閾値を超えた1つの操作だけに確定し、
 *   確定後はその操作のコールバックだけを呼び続ける（指を離すまで固定）。
 *   - onScale(ratio)      直前フレームからの拡大率
 *   - onRotate(deltaRadians) 直前フレームからの回転量(ヨー)
 *   - onVertical(deltaY)  直前フレームからの上下移動用のピクセル差分
 * - onGestureModeChange('scale' | 'rotate' | 'vertical' | null) で
 *   現在確定している操作の種類を通知する（矢印などのUI表示に使う）。
 *
 * enabled が false の間はイベントを購読しない（誤操作防止のため配置調整モード時のみ有効化する）。
 */
export function useArGestureControls({
  enabled,
  onScale,
  onRotate,
  onVertical,
  onGestureModeChange,
}) {
  const targetRef = useRef(null);
  const gestureStateRef = useRef(null);

  useEffect(() => {
    const element = targetRef.current;
    if (!element || !enabled) return undefined;

    const handleTouchStart = (event) => {
      const { touches } = event;
      if (touches.length < 2) return;

      gestureStateRef.current = {
        startDistance: getTouchDistance(touches),
        startAngle: getTouchAngle(touches),
        startMidpointY: getTouchMidpointY(touches),
        lastDistance: getTouchDistance(touches),
        lastAngle: getTouchAngle(touches),
        lastMidpointY: getTouchMidpointY(touches),
        lockedMode: null,
      };
    };

    const handleTouchMove = (event) => {
      event.preventDefault();
      const state = gestureStateRef.current;
      const { touches } = event;
      if (!state || touches.length < 2) return;

      const distance = getTouchDistance(touches);
      const angle = getTouchAngle(touches);
      const midpointY = getTouchMidpointY(touches);

      if (!state.lockedMode) {
        const scaleScore = Math.abs(Math.log(distance / state.startDistance)) / SCALE_LOG_THRESHOLD;
        const rotateScore = Math.abs(angle - state.startAngle) / ROTATE_RADIAN_THRESHOLD;
        const verticalScore =
          Math.abs(midpointY - state.startMidpointY) / VERTICAL_PIXEL_THRESHOLD;

        const bestScore = Math.max(scaleScore, rotateScore, verticalScore);
        if (bestScore >= 1) {
          if (bestScore === scaleScore) state.lockedMode = "scale";
          else if (bestScore === rotateScore) state.lockedMode = "rotate";
          else state.lockedMode = "vertical";
          onGestureModeChange?.(state.lockedMode);
        }
      }

      if (state.lockedMode === "scale") {
        onScale?.(distance / state.lastDistance);
      } else if (state.lockedMode === "rotate") {
        onRotate?.(angle - state.lastAngle);
      } else if (state.lockedMode === "vertical") {
        onVertical?.(midpointY - state.lastMidpointY);
      }

      state.lastDistance = distance;
      state.lastAngle = angle;
      state.lastMidpointY = midpointY;
    };

    const handleTouchEnd = (event) => {
      const { touches } = event;

      if (touches.length < 2) {
        if (gestureStateRef.current) onGestureModeChange?.(null);
        gestureStateRef.current = null;
      }
    };

    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: false });
    element.addEventListener("touchend", handleTouchEnd, { passive: true });
    element.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
      element.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [enabled, onScale, onRotate, onVertical, onGestureModeChange]);

  return targetRef;
}
