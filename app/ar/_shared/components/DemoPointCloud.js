"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { createSeededRandom } from "../lib/seededRandom";

/**
 * 実際のスキャンデータをまだ用意していない場合に動作確認用として
 * 表示する、球状に点を配置した色つき点群のプレースホルダー。
 * 乱数はシード固定の疑似乱数を使い、再レンダー時も同じ形状になるようにする。
 */
export function DemoPointCloud({ pointCount = 4000, radius = 0.6, pointSize = 0.02 }) {
  const geometry = useMemo(() => {
    const random = createSeededRandom(42);
    const positions = new Float32Array(pointCount * 3);
    const colors = new Float32Array(pointCount * 3);
    const color = new THREE.Color();

    for (let i = 0; i < pointCount; i += 1) {
      const direction = new THREE.Vector3(
        random() * 2 - 1,
        random() * 2 - 1,
        random() * 2 - 1,
      )
        .normalize()
        .multiplyScalar(radius * (0.85 + random() * 0.15));

      positions.set([direction.x, direction.y, direction.z], i * 3);

      color.setHSL(random(), 0.7, 0.5 + random() * 0.2);
      colors.set([color.r, color.g, color.b], i * 3);
    }

    const bufferGeometry = new THREE.BufferGeometry();
    bufferGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    bufferGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    return bufferGeometry;
  }, [pointCount, radius]);

  return (
    <points geometry={geometry}>
      <pointsMaterial size={pointSize} vertexColors sizeAttenuation />
    </points>
  );
}
