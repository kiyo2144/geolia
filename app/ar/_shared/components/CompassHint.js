"use client";

import { useMemo } from "react";
import { bearingDegrees, haversineDistanceMeters } from "../lib/geoMath";
import styles from "./CompassHint.module.css";

/**
 * 配置した3Dデータまでの距離と方位を、矢印と数値で画面上に表示する。
 * 点群がカメラの視界外にある場合でも、どちらを向けばよいか把握できるようにする。
 */
export function CompassHint({ userPosition, targetPosition, deviceHeading }) {
  const { distanceMeters, relativeBearing } = useMemo(() => {
    if (!userPosition || !targetPosition) {
      return { distanceMeters: null, relativeBearing: null };
    }

    const targetBearing = bearingDegrees(userPosition, targetPosition);
    const heading = deviceHeading ?? 0;

    return {
      distanceMeters: haversineDistanceMeters(userPosition, targetPosition),
      relativeBearing: (targetBearing - heading + 360) % 360,
    };
  }, [userPosition, targetPosition, deviceHeading]);

  if (distanceMeters === null) return null;

  return (
    <div className={styles.hint}>
      <span
        className={styles.arrow}
        style={{ transform: `rotate(${relativeBearing}deg)` }}
        aria-hidden="true"
      >
        ▲
      </span>
      <span className={styles.distance}>対象まで約 {distanceMeters.toFixed(1)} m</span>
    </div>
  );
}
