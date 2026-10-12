"use client";

import { useEffect, useRef } from "react";

// タップとみなす条件（これ以上動いた、または長押しの場合はドラッグ・長押し扱い）
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_DURATION_MS = 400;
// 2本指の操作を「ピンチ(拡大縮小)」「ドラッグ(移動)」のどちらか一方に確定するための閾値。
// 複数の意図が混ざって暴れないよう、最初に閾値を超えた操作だけを採用する
// （useArGestureControls と同じ考え方）。
const PINCH_LOG_THRESHOLD = 0.06;
const DRAG_PIXEL_THRESHOLD = 12;
// タッチ操作の直後に端末が発火する互換のマウスイベントを無視する時間
const IGNORE_MOUSE_AFTER_TOUCH_MS = 800;
// マウスホイール1目盛りあたりの拡大縮小の強さ（deltaYに掛ける）
const WHEEL_SCALE_SENSITIVITY = 0.0015;

const midpointOf = (touches) => {
  let x = 0;
  let y = 0;
  for (const touch of touches) {
    x += touch.clientX;
    y += touch.clientY;
  }
  return { x: x / touches.length, y: y / touches.length };
};

const distanceOf = (touches) => {
  const [a, b] = touches;
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
};

/**
 * AR閲覧画面の「調整モード」用の操作を検出するフック。
 * - タップ: onTap(clientX, clientY)
 * - 1本指の横ドラッグ（マウスは通常のドラッグ）: onRotateByDelta(deltaXPixels)
 * - 2本指のドラッグ（マウスはShift+ドラッグ）: onMoveByDelta(deltaXPixels, deltaYPixels)
 * - 2本指のピンチ（マウスはホイール）: onScaleBy(ratio) ※ratioは直前からの拡大率
 *
 * 2本指の操作は、最初に閾値を超えた方（ピンチかドラッグか）に確定し、指を離すまで固定する。
 * enabled が false の間はイベントを購読しない（通常のAR閲覧中は一切操作を受けない）。
 * 戻り値のrefを、Canvasの上に重ねる操作用の要素に渡す。
 */
export function useArViewAdjustGestures({
  enabled,
  onTap,
  onRotateByDelta,
  onMoveByDelta,
  onScaleBy,
}) {
  const targetRef = useRef(null);
  const handlersRef = useRef({ onTap, onRotateByDelta, onMoveByDelta, onScaleBy });
  useEffect(() => {
    handlersRef.current = { onTap, onRotateByDelta, onMoveByDelta, onScaleBy };
  });

  useEffect(() => {
    const element = targetRef.current;
    if (!element || !enabled) return undefined;

    let touchState = null;
    let mouseState = null;
    let lastTouchAt = -Infinity;

    // 指の本数が変わったとき（増減どちらも）は、基準を取り直して値のジャンプを防ぐ
    const rebase = (touches) => {
      const mid = midpointOf(touches);
      touchState.lastX = mid.x;
      touchState.lastY = mid.y;
      touchState.maxFingers = Math.max(touchState.maxFingers, touches.length);
      touchState.pinch =
        touches.length >= 2
          ? {
              startDistance: distanceOf(touches),
              lastDistance: distanceOf(touches),
              startX: mid.x,
              startY: mid.y,
              mode: null,
            }
          : null;
    };

    const handleTouchStart = (event) => {
      lastTouchAt = performance.now();
      if (!touchState) {
        const mid = midpointOf(event.touches);
        touchState = {
          startX: mid.x,
          startY: mid.y,
          startTime: performance.now(),
          lastX: mid.x,
          lastY: mid.y,
          moved: 0,
          maxFingers: event.touches.length,
          pinch: null,
        };
      }
      rebase(event.touches);
    };

    const handleTouchMove = (event) => {
      event.preventDefault();
      lastTouchAt = performance.now();
      if (!touchState || event.touches.length === 0) return;

      const mid = midpointOf(event.touches);
      const dx = mid.x - touchState.lastX;
      const dy = mid.y - touchState.lastY;
      touchState.lastX = mid.x;
      touchState.lastY = mid.y;
      touchState.moved += Math.abs(dx) + Math.abs(dy);

      if (event.touches.length >= 2 && touchState.pinch) {
        const pinch = touchState.pinch;
        const distance = distanceOf(event.touches);

        if (!pinch.mode) {
          const pinchScore =
            Math.abs(Math.log(distance / Math.max(pinch.startDistance, 1))) / PINCH_LOG_THRESHOLD;
          const dragScore =
            Math.hypot(mid.x - pinch.startX, mid.y - pinch.startY) / DRAG_PIXEL_THRESHOLD;
          const best = Math.max(pinchScore, dragScore);
          if (best >= 1) pinch.mode = pinchScore >= dragScore ? "scale" : "move";
        }

        if (pinch.mode === "scale") {
          handlersRef.current.onScaleBy?.(distance / Math.max(pinch.lastDistance, 1));
        } else if (pinch.mode === "move") {
          handlersRef.current.onMoveByDelta?.(dx, dy);
        }
        pinch.lastDistance = distance;
        return;
      }

      handlersRef.current.onRotateByDelta?.(dx);
    };

    const handleTouchEnd = (event) => {
      lastTouchAt = performance.now();
      if (event.cancelable) event.preventDefault();
      if (!touchState) return;

      if (event.touches.length > 0) {
        rebase(event.touches);
        return;
      }
      if (
        touchState.maxFingers === 1 &&
        touchState.moved < TAP_MAX_MOVE_PX &&
        performance.now() - touchState.startTime < TAP_MAX_DURATION_MS
      ) {
        handlersRef.current.onTap?.(touchState.startX, touchState.startY);
      }
      touchState = null;
    };

    const handleMouseDown = (event) => {
      if (performance.now() - lastTouchAt < IGNORE_MOUSE_AFTER_TOUCH_MS) return;
      mouseState = {
        startX: event.clientX,
        startY: event.clientY,
        startTime: performance.now(),
        lastX: event.clientX,
        lastY: event.clientY,
        moved: 0,
      };
    };

    const handleMouseMove = (event) => {
      if (!mouseState) return;
      const dx = event.clientX - mouseState.lastX;
      const dy = event.clientY - mouseState.lastY;
      mouseState.lastX = event.clientX;
      mouseState.lastY = event.clientY;
      mouseState.moved += Math.abs(dx) + Math.abs(dy);
      if (event.shiftKey) {
        handlersRef.current.onMoveByDelta?.(dx, dy);
      } else {
        handlersRef.current.onRotateByDelta?.(dx);
      }
    };

    const handleMouseUp = () => {
      if (
        mouseState &&
        mouseState.moved < TAP_MAX_MOVE_PX &&
        performance.now() - mouseState.startTime < TAP_MAX_DURATION_MS
      ) {
        handlersRef.current.onTap?.(mouseState.startX, mouseState.startY);
      }
      mouseState = null;
    };

    const handleWheel = (event) => {
      event.preventDefault();
      handlersRef.current.onScaleBy?.(Math.exp(-event.deltaY * WHEEL_SCALE_SENSITIVITY));
    };

    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: false });
    element.addEventListener("touchend", handleTouchEnd, { passive: false });
    element.addEventListener("touchcancel", handleTouchEnd, { passive: false });
    element.addEventListener("mousedown", handleMouseDown);
    element.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
      element.removeEventListener("touchcancel", handleTouchEnd);
      element.removeEventListener("mousedown", handleMouseDown);
      element.removeEventListener("wheel", handleWheel);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [enabled]);

  return targetRef;
}
