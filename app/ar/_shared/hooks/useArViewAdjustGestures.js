"use client";

import { useEffect, useRef, useState } from "react";

// タップとみなす条件（これ以上動いた、または長押しの場合はドラッグ・長押し扱い）
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_DURATION_MS = 400;
// 2回目のタップまでの間隔・位置の許容（ダブルタップ）
const DOUBLE_TAP_MAX_INTERVAL_MS = 320;
const DOUBLE_TAP_MAX_DISTANCE_PX = 40;
// 1本指のドラッグで、横回転(横方向)と縦回転(縦方向)のどちらかに確定するまでの移動量。
// 最初に閾値を超えた時点で強い方の軸に固定し、指を離すまで変えない（斜めの揺れで両方が動かないように）。
// 長押し中に指が動いたかの判定にも同じ値を使う。
const SINGLE_DRAG_LOCK_PX = 12;
// 長押し: この時間動かさずに押し続けると「高さ調整」の待機状態に入り、
// そのまま上下にドラッグすれば高さを調整、動かさずに押し続ければリセットになる。
export const HOLD_ARM_MS = 500;
export const HOLD_RESET_MS = 1200;
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

const vibrate = () => {
  try {
    navigator.vibrate?.(15);
  } catch {
    // 振動に対応していない端末では何もしない
  }
};

/**
 * AR閲覧画面の「調整モード」用の操作を検出するフック。
 * - タップ: onTap(clientX, clientY)　／ ダブルタップ: onDoubleTap(clientX, clientY)
 * - 1本指ドラッグ（マウスは通常のドラッグ）: 横=onRotateByDelta(dx) ／ 縦=onPitchByDelta(dy)
 *   最初に閾値を超えた方の軸に確定する。canPitch が false の間は縦回転せず、常に横回転にする。
 * - 長押し(0.5秒)→そのまま上下ドラッグ（マウスはAlt+ドラッグ）: onHeightByDelta(dy)
 * - 長押し(1.2秒・動かさない): onLongPressReset()
 *   長押し中の状態はonHoldPhaseChange("armed" | "height" | null)で通知する（見た目のフィードバック用）。
 * - 2本指のドラッグ（マウスはShift+ドラッグ）: onMoveByDelta(dx, dy)
 * - 2本指のピンチ（マウスはホイール）: onScaleBy(ratio) ※ratioは直前からの拡大率
 *
 * 2本指の操作は、最初に閾値を超えた方（ピンチかドラッグか）に確定し、指を離すまで固定する。
 * 2本指の操作のあとに残った1本指は、全ての指が離れるまで無視する（意図しない回転を防ぐ）。
 * enabled が false の間はイベントを購読しない。
 * 戻り値のrefを、Canvasの上に重ねる操作用の要素に渡す。
 */
export function useArViewAdjustGestures({
  enabled,
  canPitch = true,
  onTap,
  onDoubleTap,
  onRotateByDelta,
  onPitchByDelta,
  onHeightByDelta,
  onMoveByDelta,
  onScaleBy,
  onLongPressReset,
  onHoldPhaseChange,
}) {
  // 操作用の要素は、カメラ開始後など後から表示されることがあるため、refではなくstateで持ち、
  // 要素が現れた時点でイベントを購読し直す。
  const [element, setElement] = useState(null);
  const handlersRef = useRef({});
  useEffect(() => {
    handlersRef.current = {
      canPitch,
      onTap,
      onDoubleTap,
      onRotateByDelta,
      onPitchByDelta,
      onHeightByDelta,
      onMoveByDelta,
      onScaleBy,
      onLongPressReset,
      onHoldPhaseChange,
    };
  });

  useEffect(() => {
    if (!element || !enabled) return undefined;

    // 1本指（またはマウスの1ボタン）の操作
    let single = null;
    let lastTap = null;
    // 2本指以上の操作（タッチのみ）
    let touchState = null;
    let lastTouchAt = -Infinity;

    const setPhase = (session, phase) => {
      if (session.phase === phase) return;
      session.phase = phase;
      handlersRef.current.onHoldPhaseChange?.(phase);
    };

    const cancelSingle = () => {
      if (!single) return;
      clearTimeout(single.armTimer);
      clearTimeout(single.resetTimer);
      setPhase(single, null);
      single = null;
    };

    const beginSingle = (x, y) => {
      const session = {
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        startTime: performance.now(),
        maxDisplacement: 0,
        mode: null, // null | "yaw" | "pitch" | "height" | "move"
        phase: null, // null | "armed" | "height"
        consumed: false, // 長押しのリセットを実行済み
        armTimer: null,
        resetTimer: null,
      };
      single = session;

      session.armTimer = setTimeout(() => {
        if (single !== session || session.mode) return;
        setPhase(session, "armed");
        vibrate();
        session.resetTimer = setTimeout(() => {
          if (single !== session || session.mode) return;
          session.consumed = true;
          setPhase(session, null);
          vibrate();
          handlersRef.current.onLongPressReset?.();
        }, HOLD_RESET_MS - HOLD_ARM_MS);
      }, HOLD_ARM_MS);
    };

    const moveSingle = (x, y, { shiftKey = false, altKey = false } = {}) => {
      const session = single;
      if (!session) return;
      const dx = x - session.lastX;
      const dy = y - session.lastY;
      session.lastX = x;
      session.lastY = y;
      const displacement = Math.hypot(x - session.startX, y - session.startY);
      session.maxDisplacement = Math.max(session.maxDisplacement, displacement);
      if (session.consumed) return;

      // マウス用の修飾キー: Shift=位置、Alt=高さ
      if (shiftKey || altKey) {
        clearTimeout(session.armTimer);
        clearTimeout(session.resetTimer);
        setPhase(session, null);
        session.mode = shiftKey ? "move" : "height";
      }

      if (session.mode === null && session.phase === "armed") {
        // 長押しの待機中に指が動いた → 高さ調整に入る（リセットは取り消し）
        if (displacement < SINGLE_DRAG_LOCK_PX) return;
        clearTimeout(session.resetTimer);
        session.mode = "height";
        setPhase(session, "height");
        return;
      }

      if (session.mode === null) {
        if (displacement < SINGLE_DRAG_LOCK_PX) return;
        // 長押しになる前に動かした → 回転。強い方の軸に確定する
        clearTimeout(session.armTimer);
        const totalDx = x - session.startX;
        const totalDy = y - session.startY;
        const isVertical = handlersRef.current.canPitch && Math.abs(totalDy) > Math.abs(totalDx);
        session.mode = isVertical ? "pitch" : "yaw";
        if (isVertical) handlersRef.current.onPitchByDelta?.(totalDy);
        else handlersRef.current.onRotateByDelta?.(totalDx);
        return;
      }

      if (session.mode === "yaw") handlersRef.current.onRotateByDelta?.(dx);
      else if (session.mode === "pitch") handlersRef.current.onPitchByDelta?.(dy);
      else if (session.mode === "height") handlersRef.current.onHeightByDelta?.(dy);
      else if (session.mode === "move") handlersRef.current.onMoveByDelta?.(dx, dy);
    };

    const registerTap = (x, y) => {
      const now = performance.now();
      if (
        lastTap &&
        now - lastTap.time < DOUBLE_TAP_MAX_INTERVAL_MS &&
        Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_TAP_MAX_DISTANCE_PX
      ) {
        lastTap = null;
        handlersRef.current.onDoubleTap?.(x, y);
        return;
      }
      lastTap = { time: now, x, y };
      handlersRef.current.onTap?.(x, y);
    };

    const endSingle = () => {
      const session = single;
      if (!session) return;
      const isTap =
        !session.consumed &&
        !session.mode &&
        session.maxDisplacement < TAP_MAX_MOVE_PX &&
        performance.now() - session.startTime < TAP_MAX_DURATION_MS;
      cancelSingle();
      if (isTap) registerTap(session.startX, session.startY);
    };

    // --- タッチ ---
    // 指の本数が変わったとき（増減どちらも）は、基準を取り直して値のジャンプを防ぐ
    const rebase = (touches) => {
      const mid = midpointOf(touches);
      touchState.lastX = mid.x;
      touchState.lastY = mid.y;
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
      if (event.touches.length === 1 && !touchState) {
        const touch = event.touches[0];
        touchState = { multi: false, lastX: touch.clientX, lastY: touch.clientY, pinch: null };
        beginSingle(touch.clientX, touch.clientY);
        return;
      }

      // 2本指以上: 1本指の操作（長押しタイマー等）は取り消し、指を離すまで2本指の操作だけにする
      if (!touchState) touchState = { multi: true, lastX: 0, lastY: 0, pinch: null };
      cancelSingle();
      touchState.multi = true;
      rebase(event.touches);
    };

    const handleTouchMove = (event) => {
      event.preventDefault();
      lastTouchAt = performance.now();
      if (!touchState || event.touches.length === 0) return;

      if (!touchState.multi) {
        const touch = event.touches[0];
        moveSingle(touch.clientX, touch.clientY);
        return;
      }

      const mid = midpointOf(event.touches);
      const dx = mid.x - touchState.lastX;
      const dy = mid.y - touchState.lastY;
      touchState.lastX = mid.x;
      touchState.lastY = mid.y;

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
      }
    };

    const handleTouchEnd = (event) => {
      lastTouchAt = performance.now();
      if (event.cancelable) event.preventDefault();
      if (!touchState) return;

      if (event.touches.length > 0) {
        rebase(event.touches);
        return;
      }
      if (event.type === "touchcancel") cancelSingle();
      else endSingle();
      touchState = null;
    };

    // --- マウス（PCでの確認用） ---
    const handleMouseDown = (event) => {
      if (performance.now() - lastTouchAt < IGNORE_MOUSE_AFTER_TOUCH_MS) return;
      cancelSingle();
      beginSingle(event.clientX, event.clientY);
    };

    const handleMouseMove = (event) => {
      if (!single || touchState) return;
      moveSingle(event.clientX, event.clientY, {
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      });
    };

    const handleMouseUp = () => {
      if (touchState) return;
      endSingle();
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
      cancelSingle();
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
      element.removeEventListener("touchcancel", handleTouchEnd);
      element.removeEventListener("mousedown", handleMouseDown);
      element.removeEventListener("wheel", handleWheel);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [enabled, element]);

  return setElement;
}
