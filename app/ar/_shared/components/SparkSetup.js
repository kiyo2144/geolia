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

    import("@sparkjsdev/spark").then(({ SparkRenderer }) => {
      if (isCancelled) return;
      setSparkRenderer(new SparkRenderer({ renderer: gl }));
    });

    return () => {
      isCancelled = true;
    };
  }, [gl]);

  if (!sparkRenderer) return null;

  return <primitive object={sparkRenderer} />;
}
