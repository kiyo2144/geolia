"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "./RadarMinimap.module.css";

const SIZE = 140;
const CENTER = SIZE / 2;
const MAX_RADIUS = CENTER - 12;

/**
 * 画面右下に常時表示する円形のミニマップ（要件定義 docs/requirements.md 4.2.2章）。
 * 現在地を中心に、取得済みの配置を点として表示し、カメラの向き基準で回転させる
 * （常に「上」＝現在向いている方向になる）。視野内は目立つ色、視野外は薄い色で区別する。
 * タップすると簡易情報と、配置詳細画面（/placements/[id]）へのリンクを表示する。
 */
export function RadarMinimap({ heading, placements, radiusMeters }) {
  const [selected, setSelected] = useState(null);

  return (
    <div className={styles.wrapper}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className={styles.svg}>
        <circle cx={CENTER} cy={CENTER} r={MAX_RADIUS} className={styles.ring} />
        <circle cx={CENTER} cy={CENTER} r={MAX_RADIUS * 0.5} className={styles.ringInner} />

        {placements.map((p) => {
          const relativeBearing = ((p.bearing - heading) % 360 + 360) % 360;
          const radius = Math.min(p.distance_meters / radiusMeters, 1) * MAX_RADIUS;
          const angleRad = (relativeBearing * Math.PI) / 180;
          const x = CENTER + radius * Math.sin(angleRad);
          const y = CENTER - radius * Math.cos(angleRad);
          return (
            <circle
              key={p.id}
              cx={x}
              cy={y}
              r={4}
              className={p.inView ? styles.dotActive : styles.dotDim}
              onClick={() => setSelected(p)}
            />
          );
        })}

        {/* 現在向いている方向（常に真上）を示す三角マーク */}
        <polygon
          points={`${CENTER},${CENTER - MAX_RADIUS - 8} ${CENTER - 5},${CENTER - MAX_RADIUS + 3} ${CENTER + 5},${CENTER - MAX_RADIUS + 3}`}
          className={styles.headingMark}
        />
        <circle cx={CENTER} cy={CENTER} r={3.5} className={styles.userDot} />
      </svg>

      {selected && (
        <div className={styles.tooltip}>
          <button type="button" className={styles.tooltipClose} onClick={() => setSelected(null)}>
            閉じる
          </button>
          <p className={styles.tooltipLabel}>{selected.label ?? "AR配置"}</p>
          <p className={styles.tooltipDistance}>現在地から約{Math.round(selected.distance_meters)}m</p>
          <Link href={`/placements/${selected.id}`} className={styles.tooltipLink}>
            詳細を見る
          </Link>
        </div>
      )}
    </div>
  );
}
