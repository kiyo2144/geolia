"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense, useRef, useState } from "react";
import { AutoFitCamera } from "../ar/_shared/components/ThumbnailPreviewCapture";
import { PointCloudObject } from "../ar/_shared/components/PointCloudObject";
import { SparkSetup } from "../ar/_shared/components/SparkSetup";
import { SplatObject } from "../ar/_shared/components/SplatObject";
import { VrmObject } from "../ar/_shared/components/VrmObject";
import styles from "./ArPopupModelPreview.module.css";

const BACKGROUND_COLOR = "#161b22";
const DEFAULT_DISTANCE = 2.4;
const ROTATE_PIXELS_TO_RADIANS = 0.012;

function SceneContent({ groupRef, assetType, url, motionPresetKey, motionAssetUrl, rotationY }) {
  return (
    <group ref={groupRef} rotation={[0, rotationY, 0]}>
      {assetType === "gaussian_splat" ? (
        <SplatObject url={url} />
      ) : assetType === "vrm" ? (
        <VrmObject url={url} motionPresetKey={motionPresetKey} motionAssetUrl={motionAssetUrl} />
      ) : (
        <PointCloudObject url={url} />
      )}
    </group>
  );
}

/**
 * 地図上のAR配置ポップアップに埋め込む、カメラ不要の小さな3Dプレビュー。
 * VRM（実際に設定されたモーション込み）・点群・Gaussian Splatに対応する
 * （画像・GIFは既存のサムネイル画像で十分なため対象外）。
 * ThumbnailPreviewCaptureと同様、ドラッグで向きだけ変えられる（撮影機能は無い）。
 */
export function ArPopupModelPreview({ assetType, url, motionPresetKey, motionAssetUrl }) {
  const [rotationY, setRotationY] = useState(0);
  const groupRef = useRef(null);
  const dragStateRef = useRef(null);

  const handlePointerDown = (event) => {
    dragStateRef.current = { startX: event.clientX, startRotation: rotationY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handlePointerMove = (event) => {
    if (!dragStateRef.current) return;
    const dx = event.clientX - dragStateRef.current.startX;
    setRotationY(dragStateRef.current.startRotation + dx * ROTATE_PIXELS_TO_RADIANS);
  };
  const handlePointerUp = () => {
    dragStateRef.current = null;
  };

  return (
    <div
      className={styles.canvasArea}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <Canvas
        gl={{ antialias: true }}
        camera={{ fov: 45, near: 0.01, far: 2000, position: [0, 0.4, DEFAULT_DISTANCE] }}
        onCreated={({ gl }) => gl.setClearColor(BACKGROUND_COLOR, 1)}
      >
        <ambientLight intensity={1.2} />
        <directionalLight position={[2, 3, 2]} intensity={0.6} />
        {assetType === "gaussian_splat" && <SparkSetup />}
        <Suspense fallback={null}>
          <SceneContent
            groupRef={groupRef}
            assetType={assetType}
            url={url}
            motionPresetKey={motionPresetKey}
            motionAssetUrl={motionAssetUrl}
            rotationY={rotationY}
          />
          <AutoFitCamera targetRef={groupRef} />
        </Suspense>
      </Canvas>
    </div>
  );
}
