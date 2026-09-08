"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { AnimatedGifPlaneObject } from "../_shared/components/AnimatedGifPlaneObject";
import { ImagePlaneObject } from "../_shared/components/ImagePlaneObject";
import { OrientedCamera } from "../_shared/components/OrientedCamera";
import { PlacementLabelSprite } from "../_shared/components/PlacementLabelSprite";
import { PointCloudObject } from "../_shared/components/PointCloudObject";
import { SparkSetup } from "../_shared/components/SparkSetup";
import { SplatObject } from "../_shared/components/SplatObject";
import { VrmObject } from "../_shared/components/VrmObject";

// React Three Fiber の <Canvas> は position/pointerEvents 等を自前のインラインstyleで
// 持っているため、外部CSSクラスでは上書きできない。style props で直接渡す必要がある。
const CANVAS_OVERLAY_STYLE = {
  position: "absolute",
  inset: 0,
  zIndex: 1,
  pointerEvents: "none",
};

/** 詳細表示: 実データ(点群/Gaussian Splat/静止画/GIF/VRM)を読み込んで表示する */
export function DetailedPlacement({ placement, url, motionAssetUrl }) {
  return (
    <group rotation={[placement.rotation_x ?? 0, placement.rotation_y ?? 0, 0]} scale={placement.scale ?? 1}>
      {placement.asset_type === "gaussian_splat" ? (
        <SplatObject url={url} />
      ) : placement.asset_type === "image" ? (
        placement.format === "gif" ? (
          <AnimatedGifPlaneObject
            url={url}
            decorationPresetKey={placement.decoration_preset_key}
            imageEffectKey={placement.image_effect_key}
          />
        ) : (
          <ImagePlaneObject
            url={url}
            decorationPresetKey={placement.decoration_preset_key}
            imageEffectKey={placement.image_effect_key}
          />
        )
      ) : placement.asset_type === "vrm" ? (
        <VrmObject
          url={url}
          motionPresetKey={placement.motion_preset_key}
          motionAssetUrl={motionAssetUrl}
        />
      ) : (
        <PointCloudObject url={url} />
      )}
    </group>
  );
}

/**
 * 現在地周辺の複数のAR配置を同時に表示するシーン。
 * tierが'detail'のものは実データを、'simple'のものはラベルのみを表示する
 * （要件定義 docs/requirements.md 4.2.1章のLOD方式）。
 */
export function ArViewScene({ orientation, placements, getPublicUrl }) {
  const hasSplat = placements.some(
    (p) => p.tier === "detail" && p.asset_type === "gaussian_splat",
  );

  return (
    <Canvas
      style={CANVAS_OVERLAY_STYLE}
      gl={{ alpha: true, antialias: true }}
      camera={{ fov: 70, near: 0.01, far: 2000, position: [0, 0, 0] }}
      onCreated={({ gl }) => {
        // カメラ映像を透かして見せるため、描画バッファのクリア(背景)を完全透明にする
        gl.setClearAlpha(0);
      }}
    >
      <OrientedCamera orientation={orientation} />
      <ambientLight intensity={1.2} />
      {hasSplat && <SparkSetup />}

      {placements.map((placement) => (
        <group key={placement.id} position={[placement.localX, placement.localY, placement.localZ]}>
          {placement.tier === "detail" ? (
            <Suspense fallback={null}>
              <DetailedPlacement
                placement={placement}
                url={getPublicUrl(placement.storage_path)}
                motionAssetUrl={
                  placement.motion_storage_path
                    ? getPublicUrl(placement.motion_storage_path, "ar-motion-assets")
                    : null
                }
              />
            </Suspense>
          ) : (
            <PlacementLabelSprite label={placement.label} distanceMeters={placement.distance_meters} />
          )}
        </group>
      ))}
    </Canvas>
  );
}
