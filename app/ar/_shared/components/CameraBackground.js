"use client";

import styles from "./CameraBackground.module.css";

/**
 * 端末のリアカメラ映像を画面いっぱいに表示する背景レイヤー。
 * この上に AR 用の three.js Canvas を透過で重ねる。
 */
export function CameraBackground({ videoRef }) {
  return <video ref={videoRef} className={styles.background} muted playsInline autoPlay />;
}
