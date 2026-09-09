"use client";

import { useEffect, useState } from "react";

/**
 * Gaussian Splat形式(.spz / .splat / .ksplat など)の3Dデータを読み込んで描画する。
 * PLYの点群と違い、スプラットごとにRGBA(色・不透明度)を保持しているため、
 * 元データの色がそのまま表示される。
 * @sparkjsdev/spark はサイズが大きいため、実際にこの形式を使う時だけ動的importで読み込む。
 *
 * fileType: アップロード直後のプレビューでは、一時URL（blob:）に拡張子が付かず
 * @sparkjsdev/sparkがURLから形式を自動判別できないため、呼び出し側が実際の拡張子から
 * 明示的に指定する（例: "spz"）。保存済みデータ（Supabaseの公開URL）は拡張子付きの
 * URLになるため省略可。
 */
export function SplatObject({ url, fileType, onLoaded }) {
  const [splatMesh, setSplatMesh] = useState(null);

  useEffect(() => {
    let isCancelled = false;
    let mesh = null;

    import("@sparkjsdev/spark").then(({ SplatMesh }) => {
      if (isCancelled) return;
      mesh = new SplatMesh({
        url,
        fileType,
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
  }, [url, fileType, onLoaded]);

  if (!splatMesh) return null;

  return <primitive object={splatMesh} />;
}
