"use client";

import { useFrame } from "@react-three/fiber";
import { Suspense, useRef } from "react";
import { AnimatedGifPlaneObject } from "../ar/_shared/components/AnimatedGifPlaneObject";
import { ImagePlaneObject } from "../ar/_shared/components/ImagePlaneObject";
import { PointCloudObject } from "../ar/_shared/components/PointCloudObject";
import { SplatObject } from "../ar/_shared/components/SplatObject";
import { VrmObject } from "../ar/_shared/components/VrmObject";
import { PLACEMENT_AHEAD_METERS } from "./useDesktopArPlacement";
import { isPlacementOccluded } from "./occlusion";

const BILLBOARD_FORMATS = new Set(["image", "gif"]);
const GHOST_OPACITY = 0.3;
const GHOST_RENDER_ORDER = 999;

/** 地面下・建物内に置いた場合、透けて見えるようにマテリアルを調整する（元に戻せるように保持） */
function applyGhostState(group, ghost) {
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
}

function ObjectByFormat({ dataFormat, dataUrl, splatFileType, decorationPresetKey, imageEffectKey }) {
  if (!dataUrl) return null;
  if (dataFormat === "splat") return <SplatObject url={dataUrl} fileType={splatFileType} />;
  if (dataFormat === "ply") return <PointCloudObject url={dataUrl} />;
  if (dataFormat === "image")
    return (
      <ImagePlaneObject url={dataUrl} decorationPresetKey={decorationPresetKey} imageEffectKey={imageEffectKey} />
    );
  if (dataFormat === "gif")
    return (
      <AnimatedGifPlaneObject url={dataUrl} decorationPresetKey={decorationPresetKey} imageEffectKey={imageEffectKey} />
    );
  if (dataFormat === "vrm") return <VrmObject url={dataUrl} motionPresetKey="idle" motionAssetUrl={null} />;
  return null;
}

/**
 * 一人称視点のデスクトップAR設置プレビュー。
 * mode==='aiming'の間は、サブマップで明示的に選んだ地点（aimLngLat）があればそこに、
 * 無ければプレイヤーの正面に表示する。mode==='fixed'になったら確定した緯度経度の
 * 実際の位置に表示する。
 * 画像・GIFはaiming中、常にプレイヤーの方を向かせる（＝どの向きで歩いて見に行っても
 * 正しい向きで見える）。裏側から見てしまうと上下逆や鏡写しに見えるのを防ぐため。
 */
export function DesktopArPlacementPreview({
  mode,
  playerStateRef,
  project,
  sampleElevation,
  minElevation,
  aimLngLat,
  confirmedLngLat,
  adjustment,
  dataFormat,
  dataUrl,
  splatFileType,
  decorationPresetKey,
  imageEffectKey,
  livePositionRef,
  buildingFeatures,
}) {
  const outerRef = useRef(null);

  useFrame(() => {
    const group = outerRef.current;
    if (!group) return;

    let lng;
    let lat;
    let x;
    let z;
    if (mode === "aiming") {
      if (aimLngLat) {
        ({ lng, lat } = aimLngLat);
        const projected = project(lng, lat);
        x = projected.x;
        z = -projected.y;
      } else {
        const player = playerStateRef.current;
        const forwardX = -Math.sin(player.yaw);
        const forwardZ = -Math.cos(player.yaw);
        x = player.x + forwardX * PLACEMENT_AHEAD_METERS;
        z = player.z + forwardZ * PLACEMENT_AHEAD_METERS;
        ({ lng, lat } = project.unproject(x, -z));
      }
    } else if (confirmedLngLat) {
      ({ lng, lat } = confirmedLngLat);
      const projected = project(lng, lat);
      x = projected.x;
      z = -projected.y;
    } else {
      return;
    }

    const groundElevation = sampleElevation(lng, lat);
    const groundY = groundElevation - minElevation;
    group.position.set(x, groundY, z);

    if (mode === "aiming" && BILLBOARD_FORMATS.has(dataFormat)) {
      const player = playerStateRef.current;
      const dx = player.x - x;
      const dz = player.z - z;
      group.rotation.y = Math.atan2(dx, dz);
    } else {
      group.rotation.y = 0;
    }

    const altitude = groundElevation + adjustment.y;
    if (livePositionRef) {
      livePositionRef.current = { lng, lat, altitude };
    }

    const ghost = isPlacementOccluded({ lng, lat, altitude }, { sampleElevation, project, buildingFeatures });
    applyGhostState(group, ghost);
  });

  return (
    <group ref={outerRef}>
      <group position={[0, adjustment.y, 0]}>
        <group rotation={[adjustment.rotationX, adjustment.rotationY, 0]} scale={adjustment.scale}>
          <Suspense fallback={null}>
            <ObjectByFormat
              dataFormat={dataFormat}
              dataUrl={dataUrl}
              splatFileType={splatFileType}
              decorationPresetKey={decorationPresetKey}
              imageEffectKey={imageEffectKey}
            />
          </Suspense>
        </group>
      </group>
    </group>
  );
}
