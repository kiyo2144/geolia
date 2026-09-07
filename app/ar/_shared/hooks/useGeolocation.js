"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { haversineDistanceMeters } from "../../../_shared/lib/geoMath";

// 位置の平滑化・ワープ防止（要件定義 docs/requirements.md 4.1.1章の初期値）
const MAX_ACCURACY_METERS = 30; // 精度ゲート: これを超える誤差半径のfixは採用しない
const MAX_WALK_SPEED_MPS = 3; // 外れ値検知: 徒歩を想定した最大移動速度
const POSITION_EMA_ALPHA = 0.25; // 平滑化係数
const POSITION_UPDATE_THRESHOLD_METERS = 0.5; // 描画更新の間引き

/**
 * 現在地を取得・継続監視するフック。
 * watch: true の場合は watchPosition で継続的に更新し続ける。
 *
 * 生のGPS値をそのまま返すと、精度の悪いfixや外れ値によって表示位置が
 * ワープしたように見えるため、精度ゲート・外れ値検知・指数移動平均(EMA)・
 * 描画間引きを適用した「平滑化後の位置」を返す。
 */
export function useGeolocation({ watch = true } = {}) {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const watchIdRef = useRef(null);

  // 内部状態（値が変わるたびに再レンダーする必要はないためrefで保持する）
  const smoothedRef = useRef(null); // EMA適用後の最新値
  const lastEmittedRef = useRef(null); // 直近に描画へ反映した値
  const pendingOutlierRef = useRef(null); // 外れ値が実際の移動かどうかの判定用

  const start = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setError(new Error("この端末は位置情報(Geolocation API)に対応していません"));
      return;
    }

    const handleSuccess = (geoPosition) => {
      const { latitude, longitude, altitude, accuracy } = geoPosition.coords;
      const timestamp = geoPosition.timestamp;
      const raw = { lat: latitude, lng: longitude, altitude, accuracy, timestamp };

      // 1. 精度ゲート
      if (accuracy > MAX_ACCURACY_METERS) return;

      const previous = smoothedRef.current;
      if (previous) {
        const elapsedSeconds = Math.max((timestamp - previous.timestamp) / 1000, 0.001);
        const movedMeters = haversineDistanceMeters(previous, raw);
        const maxPlausibleMeters = elapsedSeconds * MAX_WALK_SPEED_MPS;

        if (movedMeters > maxPlausibleMeters) {
          // 2. 外れ値検知: 2回連続で同程度の新しい位置が得られた場合のみ実際の移動とみなす
          const pending = pendingOutlierRef.current;
          const isConsistentMove =
            pending && haversineDistanceMeters(pending, raw) < Math.max(movedMeters * 0.3, 2);
          pendingOutlierRef.current = raw;
          if (!isConsistentMove) {
            return; // 外れ値として棄却し、直前の値を使い続ける
          }
        } else {
          pendingOutlierRef.current = null;
        }
      }

      // 3. 平滑化（指数移動平均）
      const nextSmoothed = previous
        ? {
            lat: previous.lat + POSITION_EMA_ALPHA * (raw.lat - previous.lat),
            lng: previous.lng + POSITION_EMA_ALPHA * (raw.lng - previous.lng),
            altitude:
              raw.altitude === null || raw.altitude === undefined
                ? previous.altitude
                : previous.altitude === null || previous.altitude === undefined
                  ? raw.altitude
                  : previous.altitude + POSITION_EMA_ALPHA * (raw.altitude - previous.altitude),
            accuracy: raw.accuracy,
            timestamp,
          }
        : raw;
      smoothedRef.current = nextSmoothed;

      // 4. 描画更新の間引き
      const lastEmitted = lastEmittedRef.current;
      if (
        !lastEmitted ||
        haversineDistanceMeters(lastEmitted, nextSmoothed) >= POSITION_UPDATE_THRESHOLD_METERS
      ) {
        lastEmittedRef.current = nextSmoothed;
        setPosition({
          lat: nextSmoothed.lat,
          lng: nextSmoothed.lng,
          altitude: nextSmoothed.altitude ?? null,
          accuracy: nextSmoothed.accuracy,
        });
      }
      setError(null);
    };

    const handleError = (geoError) => {
      setError(geoError);
    };

    const options = { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 };

    if (watch) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        handleSuccess,
        handleError,
        options,
      );
    } else {
      navigator.geolocation.getCurrentPosition(handleSuccess, handleError, options);
    }
  }, [watch]);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return { position, error, start };
}
