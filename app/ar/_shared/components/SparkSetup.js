"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";

/**
 * Gaussian Splat(.spz等)を描画するために必要なSparkRendererをシーンに登録する。
 * @sparkjsdev/spark はサイズが大きいため、実際にSplatを表示する時だけ動的importで読み込む。
 */
export function SparkSetup() {
  const { gl } = useThree();
  const [sparkRenderer, setSparkRenderer] = useState(null);

  useEffect(() => {
    let isCancelled = false;
    let renderer = null;

    import("@sparkjsdev/spark").then(({ SparkRenderer }) => {
      if (isCancelled) return;
      renderer = new SparkRenderer({ renderer: gl });
      setSparkRenderer(renderer);
    });

    return () => {
      isCancelled = true;
      // dispose()を呼ばないと、Gaussian Splatの表示/非表示が切り替わるたびに
      // GPUリソースが解放されず蓄積し、端末のメモリ不足クラッシュにつながる
      renderer?.dispose();
    };
  }, [gl]);

  if (!sparkRenderer) return null;

  return <primitive object={sparkRenderer} />;
}
