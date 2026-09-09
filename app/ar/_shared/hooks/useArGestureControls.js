"use client";

import { useEffect, useRef } from "react";

const getTouchDistance = (touches) => {
  const [a, b] = touches;
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
};

const getTouchMidpointY = (touches) => {
  const [a, b] = touches;
  return (a.clientY + b.clientY) / 2;
};

// 2本指ジェスチャーを「拡大縮小」「上下移動」のどちらか一方に確定するための閾値。
// 複数の意図が混ざって暴れないよう、最初に閾値を超えた操作だけを採用する。
const SCALE_LOG_THRESHOLD = 0.05;
const VERTICAL_PIXEL_THRESHOLD = 10;

// 1本指スワイプによる回転の感度・慣性（フリック後、減速しながら回転し続ける）。
const ROTATE_PIXELS_TO_RADIANS = 0.012; // 1pxあたりの回転量
const INERTIA_MIN_VELOCITY = 0.0005; // これ未満の角速度(rad/ms)になったら慣性を止める
const INERTIA_DECAY_PER_MS = 0.003; // 慣性の減衰率（大きいほど早く止まる）

/**
 * AR画面上でのタッチ操作を検出するフック。
 * - 1本指スワイプで回転（ヨー）を操作する。指を離した直後の速度に応じて、
 *   慣性（だんだん減速しながら回転し続ける）を付ける。
 * - 2本指ピンチ・上下スライドは、最初に閾値を超えた1つの操作だけに確定し、
 *   確定後はその操作のコールバックだけを呼び続ける（指を離すまで固定）。
 *   - onScale(ratio)      直前フレームからの拡大率
 *   - onVertical(deltaY)  直前フレームからの上下移動用のピクセル差分
 * - onRotate(deltaRadians) 1本指スワイプ・慣性中の回転量(ヨー)
 * - onGestureModeChange('rotate' | 'scale' | 'vertical' | null) で
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
  const gestureStateRef = useRef(null); // 2本指ジェスチャー用
  const rotateStateRef = useRef(null); // 1本指スワイプ回転用
  const inertiaFrameRef = useRef(null);

  useEffect(() => {
    const element = targetRef.current;
    if (!element || !enabled) return undefined;

    const stopInertia = () => {
      if (inertiaFrameRef.current !== null) {
        cancelAnimationFrame(inertiaFrameRef.current);
        inertiaFrameRef.current = null;
      }
    };

    const runInertia = (initialVelocity) => {
      stopInertia();
      let velocity = initialVelocity;
      let lastTime = performance.now();

      const step = (time) => {
        const deltaMs = Math.min(time - lastTime, 100);
        lastTime = time;
        velocity *= Math.exp(-INERTIA_DECAY_PER_MS * deltaMs);

        if (Math.abs(velocity) < INERTIA_MIN_VELOCITY) {
          inertiaFrameRef.current = null;
          onGestureModeChange?.(null);
          return;
        }

        onRotate?.(velocity * deltaMs);
        inertiaFrameRef.current = requestAnimationFrame(step);
      };
      inertiaFrameRef.current = requestAnimationFrame(step);
    };

    const startRotateTracking = (touch) => {
      rotateStateRef.current = { lastX: touch.clientX, lastTime: performance.now(), velocity: 0 };
      onGestureModeChange?.("rotate");
    };

    const handleTouchStart = (event) => {
      const { touches } = event;
      stopInertia();

      if (touches.length === 1) {
        gestureStateRef.current = null;
        startRotateTracking(touches[0]);
      } else if (touches.length >= 2) {
        rotateStateRef.current = null;
        gestureStateRef.current = {
          startDistance: getTouchDistance(touches),
          startMidpointY: getTouchMidpointY(touches),
          lastDistance: getTouchDistance(touches),
          lastMidpointY: getTouchMidpointY(touches),
          lockedMode: null,
        };
      }
    };

    const handleTouchMove = (event) => {
      event.preventDefault();
      const { touches } = event;

      if (touches.length === 1 && rotateStateRef.current) {
        const state = rotateStateRef.current;
        const now = performance.now();
        const dx = touches[0].clientX - state.lastX;
        const dt = Math.max(now - state.lastTime, 1);
        const deltaRadians = dx * ROTATE_PIXELS_TO_RADIANS;

        onRotate?.(deltaRadians);

        state.velocity = deltaRadians / dt; // rad/ms（慣性の初速に使う）
        state.lastX = touches[0].clientX;
        state.lastTime = now;
        return;
      }

      const state = gestureStateRef.current;
      if (!state || touches.length < 2) return;

      const distance = getTouchDistance(touches);
      const midpointY = getTouchMidpointY(touches);

      if (!state.lockedMode) {
        const scaleScore = Math.abs(Math.log(distance / state.startDistance)) / SCALE_LOG_THRESHOLD;
        const verticalScore =
          Math.abs(midpointY - state.startMidpointY) / VERTICAL_PIXEL_THRESHOLD;

        const bestScore = Math.max(scaleScore, verticalScore);
        if (bestScore >= 1) {
          state.lockedMode = bestScore === scaleScore ? "scale" : "vertical";
          onGestureModeChange?.(state.lockedMode);
        }
      }

      if (state.lockedMode === "scale") {
        onScale?.(distance / state.lastDistance);
      } else if (state.lockedMode === "vertical") {
        onVertical?.(midpointY - state.lastMidpointY);
      }

      state.lastDistance = distance;
      state.lastMidpointY = midpointY;
    };

    const handleTouchEnd = (event) => {
      const { touches } = event;

      if (touches.length === 0) {
        const rotateState = rotateStateRef.current;
        rotateStateRef.current = null;
        gestureStateRef.current = null;

        if (rotateState && Math.abs(rotateState.velocity) >= INERTIA_MIN_VELOCITY) {
          runInertia(rotateState.velocity);
        } else {
          onGestureModeChange?.(null);
        }
      } else if (touches.length === 1) {
        // 2本指→1本指に減った場合は、そのままスワイプ回転として引き継ぐ
        gestureStateRef.current = null;
        startRotateTracking(touches[0]);
      }
    };

    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: false });
    element.addEventListener("touchend", handleTouchEnd, { passive: true });
    element.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      stopInertia();
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
      element.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [enabled, onScale, onRotate, onVertical, onGestureModeChange]);

  return targetRef;
}
