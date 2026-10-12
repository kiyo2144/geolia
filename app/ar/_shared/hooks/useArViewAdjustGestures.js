"use client";

import { useEffect, useRef } from "react";

// タップとみなす条件（これ以上動いた、または長押しの場合はドラッグ・長押し扱い）
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_DURATION_MS = 400;
// タッチ操作の直後に端末が発火する互換のマウスイベントを無視する時間
const IGNORE_MOUSE_AFTER_TOUCH_MS = 800;

const midpointOf = (touches) => {
  let x = 0;
  let y = 0;
  for (const touch of touches) {
    x += touch.clientX;
    y += touch.clientY;
  }
  return { x: x / touches.length, y: y / touches.length };
};

/**
 * AR閲覧画面の「調整モード」用の操作を検出するフック。
 * - タップ: onTap(clientX, clientY)
 * - 1本指の横ドラッグ（マウスは通常のドラッグ）: onRotateByDelta(deltaXPixels)
 * - 2本指のドラッグ（マウスはShift+ドラッグ）: onMoveByDelta(deltaXPixels, deltaYPixels)
 *
 * enabled が false の間はイベントを購読しない（通常のAR閲覧中は一切操作を受けない）。
 * 戻り値のrefを、Canvasの上に重ねる操作用の要素に渡す。
 */
export function useArViewAdjustGestures({ enabled, onTap, onRotateByDelta, onMoveByDelta }) {
  const targetRef = useRef(null);
  const handlersRef = useRef({ onTap, onRotateByDelta, onMoveByDelta });
  useEffect(() => {
    handlersRef.current = { onTap, onRotateByDelta, onMoveByDelta };
  });

  useEffect(() => {
    const element = targetRef.current;
    if (!element || !enabled) return undefined;

    let touchState = null;
    let mouseState = null;
    let lastTouchAt = -Infinity;

    const handleTouchStart = (event) => {
      lastTouchAt = performance.now();
      const mid = midpointOf(event.touches);
      if (!touchState) {
        touchState = {
          startX: mid.x,
          startY: mid.y,
          startTime: performance.now(),
          lastX: mid.x,
          lastY: mid.y,
          moved: 0,
          maxFingers: event.touches.length,
        };
      } else {
        // 指が増えた場合は基準を取り直し、急な値のジャンプを防ぐ
        touchState.maxFingers = Math.max(touchState.maxFingers, event.touches.length);
        touchState.lastX = mid.x;
        touchState.lastY = mid.y;
      }
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

      if (event.touches.length >= 2) {
        handlersRef.current.onMoveByDelta?.(dx, dy);
      } else {
        handlersRef.current.onRotateByDelta?.(dx);
      }
    };

    const handleTouchEnd = (event) => {
      lastTouchAt = performance.now();
      if (event.cancelable) event.preventDefault();
      if (event.touches.length > 0) {
        // 指が減った場合も基準を取り直す
        if (touchState) {
          const mid = midpointOf(event.touches);
          touchState.lastX = mid.x;
          touchState.lastY = mid.y;
        }
        return;
      }
      if (
        touchState &&
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

    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: false });
    element.addEventListener("touchend", handleTouchEnd, { passive: false });
    element.addEventListener("touchcancel", handleTouchEnd, { passive: false });
    element.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
      element.removeEventListener("touchcancel", handleTouchEnd);
      element.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [enabled]);

  return targetRef;
}
