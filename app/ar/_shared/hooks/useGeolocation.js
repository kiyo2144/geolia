"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { haversineDistanceMeters } from "../../../_shared/lib/geoMath";

// 位置の平滑化・ワープ防止（要件定義 docs/requirements.md 4.1.1章の初期値）
const MAX_ACCURACY_METERS = 30; // 精度ゲート: これを超える誤差半径のfixは採用しない
const MAX_WALK_SPEED_MPS = 3; // 外れ値検知: 徒歩を想定した最大移動速度
// 平滑化係数（EMA）のデフォルト値。値が小さいほど滑らかだが追従が遅れる。
// AR閲覧画面のように「歩いた分だけAR配置が近づいて見える」ことが重要な場面では、
// 呼び出し側からより大きい値を渡して追従を速める（useGeolocationのemaAlphaオプション）。
const DEFAULT_POSITION_EMA_ALPHA = 0.25;
// 描画更新の間引き。AR閲覧画面は歩いてAR配置の周りを回り込む体験のため、
// 間引きが粗いと少し動いただけでは表示が追従せず「画面に張り付いている」ように
// 感じられる（実機検証で判明）。AR設置側は設置確定後は自己位置を固定して使う
// ため、この値を小さくしてもワープ防止への影響はない。
const POSITION_UPDATE_THRESHOLD_METERS = 0.2;

// watchPositionのポーリング間隔。iOS Safari等でwatchPositionが実際には新しいfixを
// 取得せず、直前と同じキャッシュ済みのcoordsを繰り返しコールバックへ渡し続ける不具合が
// 実機検証で確認されたため、watchPositionではなくgetCurrentPosition(maximumAge:0で
// キャッシュを無効化)を一定間隔で呼び直す方式にした。
const WATCH_POLL_INTERVAL_MS = 1000;

// 高度のブレ（不安定さ）を測る際にさかのぼる時間幅。この間に得られた生のGPS高度値の
// 標準偏差を「その場でのブレ」として使う（画面表示には反映せず、内部計測のみに使う）。
const ALTITUDE_JITTER_WINDOW_MS = 4000;

function computeStandardDeviation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * 現在地を取得・継続監視するフック。
 * watch: true の場合は getCurrentPosition を一定間隔でポーリングして継続的に更新し続ける
 * （watchPositionはiOS Safari等で新しいfixを取得せず同じcoordsを返し続けることがあるため使わない）。
 *
 * 生のGPS値をそのまま返すと、精度の悪いfixや外れ値によって表示位置が
 * ワープしたように見えるため、精度ゲート・外れ値検知・指数移動平均(EMA)・
 * 描画間引きを適用した「平滑化後の位置」を返す。
 */
export function useGeolocation({ watch = true, emaAlpha = DEFAULT_POSITION_EMA_ALPHA } = {}) {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const watchIdRef = useRef(null); // watch:trueの場合はsetIntervalのid、falseの場合は未使用
  const isFetchingRef = useRef(false); // ポーリング中に前回のgetCurrentPositionが未応答なら重複起動を防ぐ

  // 内部状態（値が変わるたびに再レンダーする必要はないためrefで保持する）
  const smoothedRef = useRef(null); // EMA適用後の最新値
  const lastEmittedRef = useRef(null); // 直近に描画へ反映した値
  const pendingOutlierRef = useRef(null); // 外れ値が実際の移動かどうかの判定用
  // 直近数秒分の生の高度値（表示には使わず、ブレの計測専用）
  const recentAltitudeSamplesRef = useRef([]);
  // 位置追従の遅れ・停止の原因切り分け用（一時的な計測。画面表示側で使う）。
  // watchPositionの生fixが「そもそも来ているか」「どの段階で棄却されているか」を可視化する。
  const [debugInfo, setDebugInfo] = useState({
    rawFixCount: 0,
    acceptedCount: 0,
    accuracyRejectedCount: 0,
    outlierRejectedCount: 0,
    lastRawAccuracy: null,
    lastRejectReason: null,
    lastRawLat: null,
    lastRawLng: null,
    lastRawTimestamp: null,
    sameAsPreviousRawCount: 0, // 生fixが直前と全く同じ座標だった回数（watchPositionのキャッシュ再送の疑い）
  });
  const lastRawPositionRef = useRef(null);

  const start = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setError(new Error("この端末は位置情報(Geolocation API)に対応していません"));
      return;
    }

    const handleSuccess = (geoPosition) => {
      const { latitude, longitude, altitude, accuracy } = geoPosition.coords;
      const timestamp = geoPosition.timestamp;
      const raw = { lat: latitude, lng: longitude, altitude, accuracy, timestamp };

      const lastRaw = lastRawPositionRef.current;
      const isSameAsPreviousRaw = lastRaw && lastRaw.lat === raw.lat && lastRaw.lng === raw.lng;
      lastRawPositionRef.current = raw;
      setDebugInfo((prev) => ({
        ...prev,
        rawFixCount: prev.rawFixCount + 1,
        lastRawAccuracy: accuracy,
        lastRawLat: raw.lat,
        lastRawLng: raw.lng,
        lastRawTimestamp: timestamp,
        sameAsPreviousRawCount: prev.sameAsPreviousRawCount + (isSameAsPreviousRaw ? 1 : 0),
      }));

      // 1. 精度ゲート
      if (accuracy > MAX_ACCURACY_METERS) {
        setDebugInfo((prev) => ({
          ...prev,
          accuracyRejectedCount: prev.accuracyRejectedCount + 1,
          lastRejectReason: `精度不足(${Math.round(accuracy)}m > ${MAX_ACCURACY_METERS}m)`,
        }));
        return;
      }

      // 高度のブレ計測用に、直近ALTITUDE_JITTER_WINDOW_MS分の生の高度値を保持する
      // （表示用の平滑化とは別系統。画面には反映しない）
      if (altitude !== null && altitude !== undefined) {
        const samples = recentAltitudeSamplesRef.current;
        samples.push({ altitude, timestamp });
        while (samples.length > 0 && timestamp - samples[0].timestamp > ALTITUDE_JITTER_WINDOW_MS) {
          samples.shift();
        }
      }

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
            setDebugInfo((prev) => ({
              ...prev,
              outlierRejectedCount: prev.outlierRejectedCount + 1,
              lastRejectReason: `外れ値(${Math.round(movedMeters)}m/${elapsedSeconds.toFixed(1)}s)`,
            }));
            return; // 外れ値として棄却し、直前の値を使い続ける
          }
        } else {
          pendingOutlierRef.current = null;
        }
      }

      // 3. 平滑化（指数移動平均）
      const nextSmoothed = previous
        ? {
            lat: previous.lat + emaAlpha * (raw.lat - previous.lat),
            lng: previous.lng + emaAlpha * (raw.lng - previous.lng),
            altitude:
              raw.altitude === null || raw.altitude === undefined
                ? previous.altitude
                : previous.altitude === null || previous.altitude === undefined
                  ? raw.altitude
                  : previous.altitude + emaAlpha * (raw.altitude - previous.altitude),
            accuracy: raw.accuracy,
            timestamp,
          }
        : raw;
      smoothedRef.current = nextSmoothed;
      setDebugInfo((prev) => ({ ...prev, acceptedCount: prev.acceptedCount + 1 }));

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

    if (watch) {
      const pollOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
      const poll = () => {
        if (isFetchingRef.current) return; // 前回のfix取得がまだ終わっていなければ重複起動しない
        isFetchingRef.current = true;
        navigator.geolocation.getCurrentPosition(
          (geoPosition) => {
            isFetchingRef.current = false;
            handleSuccess(geoPosition);
          },
          (geoError) => {
            isFetchingRef.current = false;
            handleError(geoError);
          },
          pollOptions,
        );
      };
      poll();
      watchIdRef.current = setInterval(poll, WATCH_POLL_INTERVAL_MS);
    } else {
      const options = { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 };
      navigator.geolocation.getCurrentPosition(handleSuccess, handleError, options);
    }
  }, [watch, emaAlpha]);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        clearInterval(watchIdRef.current);
      }
    };
  }, []);

  // 直近数秒間の生の高度値から標準偏差を計算して返す（画面表示は平滑化した値のまま
  // 変えず、呼び出し側がAR設置確定などのタイミングで都度取得する想定）。
  const getAltitudeJitter = useCallback(() => {
    const values = recentAltitudeSamplesRef.current.map((sample) => sample.altitude);
    return computeStandardDeviation(values);
  }, []);

  return { position, error, start, getAltitudeJitter, debugInfo };
}
