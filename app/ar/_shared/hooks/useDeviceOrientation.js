"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const isIosPermissionRequired = () =>
  typeof DeviceOrientationEvent !== "undefined" &&
  typeof DeviceOrientationEvent.requestPermission === "function";

// 方位の平滑化（要件定義 docs/requirements.md 4.1.1章の初期値）。
// alpha/beta/gammaはいずれも循環量（角度）のため、単純平均ではなくベクトル平均
// （sin/cosに変換して平均し、atan2で戻す）で滑らかにする。位置の平滑化よりやや強め。
const ORIENTATION_EMA_ALPHA = 0.15;
const ORIENTATION_UPDATE_THRESHOLD_DEGREES = 2;

// 循環量(角度)のベクトル平均。戻り値は-180〜180度の範囲になる。
function circularEmaDegrees(previousDeg, newDeg, alpha) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const sin = Math.sin(toRad(previousDeg)) * (1 - alpha) + Math.sin(toRad(newDeg)) * alpha;
  const cos = Math.cos(toRad(previousDeg)) * (1 - alpha) + Math.cos(toRad(newDeg)) * alpha;
  return (Math.atan2(sin, cos) * 180) / Math.PI;
}

// 0〜360度の範囲に正規化する（alpha・コンパス方位向け）
function normalizeDegrees360(deg) {
  return ((deg % 360) + 360) % 360;
}

// 2つの角度の差（絶対値、0〜180度）。表現レンジが異なっても正しく比較できる。
function circularDiffDegrees(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * 端末の姿勢（alpha/beta/gamma）を購読するフック。
 * iOS 13+ の Safari では明示的なユーザー操作による requestPermission() 呼び出しが必須。
 *
 * 生の値をそのまま反映するとノイズでカメラ映像が小刻みに揺れるため、
 * ベクトル平均による平滑化と、変化が一定角度未満の場合は更新しない間引きを行う。
 */
export function useDeviceOrientation() {
  const [orientation, setOrientation] = useState(null);
  const [permissionState, setPermissionState] = useState(
    isIosPermissionRequired() ? "prompt" : "granted",
  );
  const [error, setError] = useState(null);

  const smoothedRef = useRef(null);
  const lastEmittedRef = useRef(null);

  const handleOrientation = useCallback((event) => {
    const { alpha, beta, gamma } = event;
    if (alpha === null || beta === null || gamma === null) return;

    const screenAngle = window.screen?.orientation?.angle ?? window.orientation ?? 0;
    // iOS では webkitCompassHeading の方が真北基準として信頼できる
    const compassHeading =
      typeof event.webkitCompassHeading === "number" ? event.webkitCompassHeading : null;

    const previous = smoothedRef.current;
    const smoothed = previous
      ? {
          alpha: normalizeDegrees360(circularEmaDegrees(previous.alpha, alpha, ORIENTATION_EMA_ALPHA)),
          beta: circularEmaDegrees(previous.beta, beta, ORIENTATION_EMA_ALPHA),
          gamma: circularEmaDegrees(previous.gamma, gamma, ORIENTATION_EMA_ALPHA),
          compassHeading:
            compassHeading === null
              ? previous.compassHeading
              : normalizeDegrees360(
                  circularEmaDegrees(
                    previous.compassHeading ?? compassHeading,
                    compassHeading,
                    ORIENTATION_EMA_ALPHA,
                  ),
                ),
          screenAngle,
        }
      : { alpha: normalizeDegrees360(alpha), beta, gamma, compassHeading, screenAngle };
    smoothedRef.current = smoothed;

    const lastEmitted = lastEmittedRef.current;
    const changedEnough =
      !lastEmitted ||
      circularDiffDegrees(lastEmitted.alpha, smoothed.alpha) >= ORIENTATION_UPDATE_THRESHOLD_DEGREES ||
      circularDiffDegrees(lastEmitted.beta, smoothed.beta) >= ORIENTATION_UPDATE_THRESHOLD_DEGREES ||
      circularDiffDegrees(lastEmitted.gamma, smoothed.gamma) >= ORIENTATION_UPDATE_THRESHOLD_DEGREES;

    if (changedEnough) {
      lastEmittedRef.current = smoothed;
      setOrientation(smoothed);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    if (!isIosPermissionRequired()) {
      window.addEventListener("deviceorientation", handleOrientation);
      setPermissionState("granted");
      return;
    }

    try {
      const result = await DeviceOrientationEvent.requestPermission();
      setPermissionState(result);

      if (result === "granted") {
        window.addEventListener("deviceorientation", handleOrientation);
      }
    } catch (requestError) {
      setError(requestError);
      setPermissionState("denied");
    }
  }, [handleOrientation]);

  useEffect(() => {
    if (!isIosPermissionRequired()) {
      window.addEventListener("deviceorientation", handleOrientation);
    }

    return () => window.removeEventListener("deviceorientation", handleOrientation);
  }, [handleOrientation]);

  return { orientation, permissionState, requestPermission, error };
}
