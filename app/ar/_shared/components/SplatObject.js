"use client";

import { useEffect, useState } from "react";

/**
 * Gaussian Splat形式(.spz / .splat / .ksplat など)の3Dデータを読み込んで描画する。
 * PLYの点群と違い、スプラットごとにRGBA(色・不透明度)を保持しているため、
 * 元データの色がそのまま表示される。
 * @sparkjsdev/spark はサイズが大きいため、実際にこの形式を使う時だけ動的importで読み込む。
 */
export function SplatObject({ url, onLoaded }) {
  const [splatMesh, setSplatMesh] = useState(null);

  useEffect(() => {
    let isCancelled = false;
    let mesh = null;

    import("@sparkjsdev/spark").then(({ SplatMesh }) => {
      if (isCancelled) return;
      mesh = new SplatMesh({
        url,
        onLoad: () => {
          if (!isCancelled) onLoaded?.();
        },
      });
      setSplatMesh(mesh);
    });

    return () => {
      isCancelled = true;
      mesh?.dispose();
    };
  }, [url, onLoaded]);

  if (!splatMesh) return null;

  return <primitive object={splatMesh} />;
}
