"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";

// 地面下・建物内にあるAR配置を、透けて見える表示にする際の不透明度
const GHOST_OPACITY = 0.3;
const GHOST_RENDER_ORDER = 999;

/**
 * ghost=true の間、配下のメッシュのマテリアルを半透明・深度テスト無効にし、
 * 地形や建物の裏にあっても透けて見えるようにする（元の見た目は復元可能に保持する）。
 * 中身（点群・Gaussian Splat・画像・VRM等）が非同期に読み込まれ、後からメッシュが
 * 追加されることがあるため、毎フレームtraverseして新しく現れたメッシュにも適用する。
 */
export function GhostablePlacement({ ghost, children }) {
  const groupRef = useRef(null);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    group.traverse((object) => {
      if (!object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material.userData.__ghostBaseOpacity === undefined) {
          material.userData.__ghostBaseOpacity = material.opacity;
          material.userData.__ghostBaseTransparent = material.transparent;
          material.userData.__ghostBaseDepthTest = material.depthTest;
        }
        if (ghost) {
          material.transparent = true;
          material.opacity = Math.min(material.userData.__ghostBaseOpacity, GHOST_OPACITY);
          material.depthTest = false;
          object.renderOrder = GHOST_RENDER_ORDER;
        } else {
          material.opacity = material.userData.__ghostBaseOpacity;
          material.transparent = material.userData.__ghostBaseTransparent;
          material.depthTest = material.userData.__ghostBaseDepthTest;
          object.renderOrder = 0;
        }
      }
    });
  });

  return <group ref={groupRef}>{children}</group>;
}
