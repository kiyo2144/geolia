"use client";

import { useLoader } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

const LOW_COLOR = new THREE.Color("#2b6cff");
const HIGH_COLOR = new THREE.Color("#ff5252");

/**
 * LiDARスキャンなどで生成した点群データ(.ply)を読み込んで描画する。
 * url は File から URL.createObjectURL() で作った一時URL、または通常のパスを想定。
 * 頂点カラー(RGB)を含まないデータの場合は、高さ(Y軸)に応じたグラデーション配色を
 * 自動生成し、単色の塊にならず形状を見やすくする。
 */
export function PointCloudObject({ url, pointSize = 0.02, onVertexColorDetected }) {
  const geometry = useLoader(PLYLoader, url);

  const hasVertexColors = useMemo(() => {
    geometry.computeBoundingSphere();
    geometry.center();

    if (geometry.hasAttribute("color")) return true;

    const positions = geometry.getAttribute("position");
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < positions.count; i += 1) {
      const y = positions.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const range = maxY - minY || 1;
    const colors = new Float32Array(positions.count * 3);
    const color = new THREE.Color();

    for (let i = 0; i < positions.count; i += 1) {
      const t = (positions.getY(i) - minY) / range;
      color.lerpColors(LOW_COLOR, HIGH_COLOR, t);
      colors.set([color.r, color.g, color.b], i * 3);
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return false;
  }, [geometry]);

  useEffect(() => {
    onVertexColorDetected?.(hasVertexColors);
  }, [hasVertexColors, onVertexColorDetected]);

  return (
    <points geometry={geometry}>
      <pointsMaterial size={pointSize} vertexColors sizeAttenuation />
    </points>
  );
}
