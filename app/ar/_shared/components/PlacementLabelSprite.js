"use client";

import { useMemo } from "react";
import * as THREE from "three";

// 距離は近づくたびに細かく再生成されないよう、5m単位に丸めてテクスチャをキャッシュする
function roundDistance(distanceMeters) {
  return Math.round(distanceMeters / 5) * 5;
}

function buildLabelTexture(label, distanceMeters) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "rgba(13, 17, 23, 0.75)";
  ctx.beginPath();
  ctx.roundRect(0, 40, canvas.width, 80, 24);
  ctx.fill();

  ctx.fillStyle = "#8e44ad";
  ctx.beginPath();
  ctx.arc(canvas.width / 2, 24, 20, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 36px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label ?? "AR配置", canvas.width / 2, 76, canvas.width - 40);

  ctx.font = "28px sans-serif";
  ctx.fillStyle = "#c9d1d9";
  ctx.fillText(`約${Math.round(distanceMeters)}m`, canvas.width / 2, 112);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 「簡易表示」用のマーカー。実データは読み込まず、アイコン＋名前＋距離のラベルを
 * three.jsのSprite（常にカメラの方を向く板）として表示する。
 */
export function PlacementLabelSprite({ label, distanceMeters }) {
  const roundedDistance = roundDistance(distanceMeters);
  const texture = useMemo(
    () => buildLabelTexture(label, roundedDistance),
    [label, roundedDistance],
  );

  return (
    <sprite scale={[1.6, 0.5, 1]}>
      <spriteMaterial map={texture} depthWrite={false} transparent />
    </sprite>
  );
}
