"use client";

import { useEffect } from "react";

/**
 * iOS Safariのピンチ操作によるページ全体の拡大を無効にする。
 * viewportの user-scalable=no は、iOS Safariではピンチ拡大に効かないことがあるため、
 * iOS独自の gesturestart / gesturechange イベントを止めて確実に拡大を防ぐ。
 * 3Dマップ（MapLibre）の地図自身のピンチズームはタッチイベントで処理されるため影響しない。
 */
export function PreventPageZoom() {
  useEffect(() => {
    const preventGesture = (event) => event.preventDefault();

    document.addEventListener("gesturestart", preventGesture, { passive: false });
    document.addEventListener("gesturechange", preventGesture, { passive: false });
    return () => {
      document.removeEventListener("gesturestart", preventGesture);
      document.removeEventListener("gesturechange", preventGesture);
    };
  }, []);

  return null;
}
