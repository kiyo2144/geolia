"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { AnimatedGifPlaneObject } from "../_shared/components/AnimatedGifPlaneObject";
import { HtmlPlaneObject } from "../_shared/components/HtmlPlaneObject";
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
      ) : placement.asset_type === "html" ? (
        <HtmlPlaneObject url={url} />
      ) : (
        <PointCloudObject url={url} />
      )}
    </group>
  );
}

const DEBUG_DISTANCE_LABEL_HEIGHT_OFFSET = 1; // 詳細表示のオブジェクトの上に出す高さ(m)

/** デバッグ用: detail表示のオブジェクトの上に、デバイスからの距離だけを出す簡易ラベル（原因切り分けが済んだら削除する） */
function DebugDistanceLabel({ distanceMeters }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(230, 57, 70, 0.85)";
    ctx.beginPath();
    ctx.roundRect(0, 16, canvas.width, 64, 20);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 36px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`約${distanceMeters.toFixed(1)}m`, canvas.width / 2, 48);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [distanceMeters]);

  return (
    // デバッグ用の補助表示のため、角度によって本体の裏に隠れて見えなくならないよう
    // 深度テストを無効にして常に手前に描画する（renderOrderで描画順も後にする）。
    <sprite
      position={[0, DEBUG_DISTANCE_LABEL_HEIGHT_OFFSET, 0]}
      scale={[0.8, 0.3, 1]}
      renderOrder={999}
    >
      <spriteMaterial map={texture} depthWrite={false} depthTest={false} transparent />
    </sprite>
  );
}

// 自己位置の更新間隔(最大1秒, useGeolocationのWATCH_POLL_INTERVAL_MS)の間、
// AR配置側の描画位置が完全に静止してしまい、歩いている間「画面に張り付いて
// 追従している」ように見える問題への対策。毎フレーム、現在の描画位置から
// 最新の目標位置(localX/Y/Z)へ滑らかに近づける（指数的減衰、フレームレート非依存）。
// 値が大きいほど早く追いつくが大きすぎると結局ガクッと動いて見える。
const POSITION_LERP_RATE_PER_SECOND = 3;

/** 目標位置(target)へ毎フレーム滑らかに近づく<group>。新規表示時はワープ演出を避けるため即座に目標位置へ合わせる。 */
function SmoothedPositionGroup({ target, children }) {
  const groupRef = useRef(null);
  const isInitializedRef = useRef(false);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    const [tx, ty, tz] = target;

    if (!isInitializedRef.current) {
      group.position.set(tx, ty, tz);
      isInitializedRef.current = true;
      return;
    }

    const t = 1 - Math.exp(-POSITION_LERP_RATE_PER_SECOND * delta);
    group.position.x += (tx - group.position.x) * t;
    group.position.y += (ty - group.position.y) * t;
    group.position.z += (tz - group.position.z) * t;
  });

  return <group ref={groupRef}>{children}</group>;
}


// 調整モードで、タップした位置に最も近いコンテンツを選ぶ際の、画面上の許容距離(px)の下限。
// 大きく表示されているコンテンツは、見かけの半径がこれより大きければそちらを使う
// （中心から離れた部分をタップしても選べるようにするため）。
const PICK_RADIUS_PX = 100;
const MAX_APPARENT_RADIUS_PX = 220;
const SELECTION_RING_COLOR = "#4da6ff";
const ZERO_INDIVIDUAL_ADJUSTMENT = { east: 0, north: 0, up: 0, yaw: 0, scale: 1 };
const ZERO_GLOBAL_ADJUSTMENT = { east: 0, north: 0, yaw: 0 };
// 「正面に呼ぶ」で置く距離(m)。コンテンツの大きさ(scale)に比例して離し、画面に収める。
const FRONT_DISTANCE_PER_SCALE_METERS = 2;
const FRONT_DISTANCE_MIN_METERS = 2;
const FRONT_DISTANCE_MAX_METERS = 15;
// VRMなど原点が足元にあるものは、目の高さではなく少し下げて全身が見えるようにする
const FRONT_VERTICAL_OFFSET_BY_ASSET_TYPE = { vrm: -1.2 };

/** 調整モードで選択中のコンテンツの周りに表示する輪（深度テストなしで常に手前に見せる） */
function SelectionRing() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={998}>
      <ringGeometry args={[0.55, 0.62, 48]} />
      <meshBasicMaterial
        color={SELECTION_RING_COLOR}
        transparent
        opacity={0.9}
        depthTest={false}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * 調整モード中の、Canvas内で行う処理をまとめたコンポーネント（毎フレーム1回）。
 * 1. タップ位置から、最も近い詳細表示のコンテンツを選ぶ（pickRequestRef）
 *    点群・Splat・VRM・HTMLなど種別を問わず選べるよう、レイキャストではなく
 *    各コンテンツの基準点を画面座標へ投影した距離で判定する。何も無い所のタップは選択解除。
 * 2. 「正面に呼ぶ」: 選択中のコンテンツを、カメラの正面でこちらを向く位置へ移す補正値を求める
 *    （bringRequestRef）。求めた値はonBroughtで親へ返し、親が状態に反映する。
 * 3. 選択中のコンテンツの画面上の位置・大きさを、ハイライト用のDOMを持つ親へonReticleUpdateで毎フレーム伝える。
 */
function AdjustInteractionBridge({
  groupsRef,
  latestRef,
  selectedId,
  pickRequestRef,
  bringRequestRef,
  onReticleUpdate,
  onPick,
  onBrought,
}) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);

  useFrame(() => {
    const { placementsById, adjustments } = latestRef.current;
    const rect = gl.domElement.getBoundingClientRect();
    const focalPx = rect.height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const worldPosition = new THREE.Vector3();

    // 画面上の見かけの半径(px)の概算。基準の大きさを横幅1mとして、スケールと距離から求める
    const apparentRadiusPx = (id, distanceMeters) => {
      const totalScale = (placementsById.get(id)?.scale ?? 1) * (adjustments.byId[id]?.scale ?? 1);
      return Math.min(
        (0.5 * totalScale * focalPx) / Math.max(distanceMeters, 0.1),
        MAX_APPARENT_RADIUS_PX,
      );
    };

    // 画面座標へ投影する。カメラの後ろ・遠方クリップ面の外ならnull
    const project = (object) => {
      object.getWorldPosition(worldPosition);
      const distance = worldPosition.distanceTo(camera.position);
      worldPosition.project(camera);
      if (worldPosition.z < -1 || worldPosition.z > 1) return null;
      return {
        x: ((worldPosition.x + 1) / 2) * rect.width,
        y: ((1 - worldPosition.y) / 2) * rect.height,
        distance,
      };
    };

    const pickRequest = pickRequestRef?.current;
    if (pickRequest) {
      pickRequestRef.current = null;
      const pointerX = pickRequest.x - rect.left;
      const pointerY = pickRequest.y - rect.top;

      let bestId = null;
      let bestDistance = Infinity;
      for (const [id, object] of groupsRef.current) {
        const screen = project(object);
        if (!screen) continue;
        const distance = Math.hypot(screen.x - pointerX, screen.y - pointerY);
        const radius = Math.max(PICK_RADIUS_PX, apparentRadiusPx(id, screen.distance));
        if (distance <= radius && distance < bestDistance) {
          bestDistance = distance;
          bestId = id;
        }
      }
      onPick?.(bestId);
    }

    const bringRequest = bringRequestRef?.current;
    if (bringRequest) {
      bringRequestRef.current = null;
      const object = groupsRef.current.get(bringRequest.id);
      const placement = placementsById.get(bringRequest.id);
      if (object?.parent && placement) {
        const current = adjustments.byId[bringRequest.id] ?? ZERO_INDIVIDUAL_ADJUSTMENT;
        const totalScale = (placement.scale ?? 1) * current.scale;
        const distance = THREE.MathUtils.clamp(
          FRONT_DISTANCE_PER_SCALE_METERS * totalScale,
          FRONT_DISTANCE_MIN_METERS,
          FRONT_DISTANCE_MAX_METERS,
        );

        // カメラの向きの水平成分だけを使い、傾けて見ていても同じ高さに置く
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        direction.y = 0;
        if (direction.lengthSq() < 1e-6) direction.set(0, 0, -1);
        direction.normalize();

        const target = new THREE.Vector3(
          direction.x * distance,
          FRONT_VERTICAL_OFFSET_BY_ASSET_TYPE[placement.asset_type] ?? 0,
          direction.z * distance,
        );

        // 補正値は親(GPS追従の<group>)から見た位置なので、ワールド座標から変換して求める
        object.parent.updateWorldMatrix(true, false);
        const local = object.parent.worldToLocal(target.clone());
        // こちら(原点のカメラ)を向く向き。全体補正の回転と、データ自身の向きは引いておく
        const facingYaw = Math.atan2(-target.x, -target.z);
        const yaw = facingYaw - adjustments.global.yaw - (placement.rotation_y ?? 0);

        onBrought?.(bringRequest.id, {
          east: local.x,
          north: -local.z,
          up: local.y,
          yaw,
          scale: current.scale,
        });
      }
    }

    // 選択中のコンテンツへ、ハイライト(リング+名前)のDOMを追従させる（DOM更新は親のコールバックで行う）
    const object = selectedId ? groupsRef.current.get(selectedId) : null;
    const screen = object ? project(object) : null;
    if (!screen) {
      onReticleUpdate?.(null);
    } else {
      onReticleUpdate?.({
        x: screen.x,
        y: screen.y,
        diameter: Math.max(apparentRadiusPx(selectedId, screen.distance) * 2, 56),
      });
    }
  });

  return null;
}

/**
 * 現在地周辺の複数のAR配置を同時に表示するシーン。
 * tierが'detail'のものは実データを、'simple'のものはラベルのみを表示する
 * （要件定義 docs/requirements.md 4.2.1章のLOD方式）。
 *
 * adjustments: 画面を開いている間だけの見た目上の位置・角度・大きさの補正（DBには保存しない）。
 *   { byId: { [id]: { east, north, up, yaw, scale } }, global: { east, north, yaw } }
 *   いずれも「ユーザーの現在地を原点としたワールド固定」の値で、歩いても画面に張り付かない。
 *   global は全コンテンツをまとめて、現在地を中心に yaw だけ回してから east/north へ動かす
 *   （コンパスのズレのように全体に共通して出る誤差の補正用）。
 */
export function ArViewScene({
  orientation,
  placements,
  getPublicUrl,
  showDebugInfo = false,
  adjustments = null,
  selectedId = null,
  isAdjustMode = false,
  pickRequestRef = null,
  bringRequestRef = null,
  onReticleUpdate = null,
  onPick = null,
  onBrought = null,
}) {
  const hasSplat = placements.some(
    (p) => p.tier === "detail" && p.asset_type === "gaussian_splat",
  );
  const groupsRef = useRef(new Map());
  const globalAdjustment = adjustments?.global ?? ZERO_GLOBAL_ADJUSTMENT;

  // Canvas内の毎フレーム処理から、最新のplacements・補正値を参照するためのref
  const latestRef = useRef({ placementsById: new Map(), adjustments: { byId: {}, global: ZERO_GLOBAL_ADJUSTMENT } });
  useEffect(() => {
    latestRef.current = {
      placementsById: new Map(placements.map((placement) => [placement.id, placement])),
      adjustments: adjustments ?? { byId: {}, global: ZERO_GLOBAL_ADJUSTMENT },
    };
  });

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
      {isAdjustMode && (
        <AdjustInteractionBridge
          groupsRef={groupsRef}
          latestRef={latestRef}
          selectedId={selectedId}
          pickRequestRef={pickRequestRef}
          bringRequestRef={bringRequestRef}
          onReticleUpdate={onReticleUpdate}
          onPick={onPick}
          onBrought={onBrought}
        />
      )}

      {/* 全体補正: 現在地(原点)を中心に回してから平行移動する（localX=東, localZ=-北） */}
      <group
        position={[globalAdjustment.east, 0, -globalAdjustment.north]}
        rotation={[0, globalAdjustment.yaw, 0]}
      >
        {placements.map((placement) => {
          const adjustment = adjustments?.byId?.[placement.id] ?? ZERO_INDIVIDUAL_ADJUSTMENT;
          const isDetail = placement.tier === "detail";
          return (
            <SmoothedPositionGroup
              key={placement.id}
              target={[placement.localX, placement.localY, placement.localZ]}
            >
              {/* 個別補正: GPS位置への追従(上の補間)とは独立に、即座に反映する */}
              <group
                ref={
                  isDetail
                    ? (object) => {
                        if (object) groupsRef.current.set(placement.id, object);
                        else groupsRef.current.delete(placement.id);
                      }
                    : undefined
                }
                position={[adjustment.east, adjustment.up, -adjustment.north]}
                rotation={[0, adjustment.yaw, 0]}
                scale={adjustment.scale}
              >
                {isDetail ? (
                  <>
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
                    {showDebugInfo && <DebugDistanceLabel distanceMeters={placement.distance_meters} />}
                    {isAdjustMode && selectedId === placement.id && <SelectionRing />}
                  </>
                ) : (
                  <PlacementLabelSprite label={placement.label} distanceMeters={placement.distance_meters} />
                )}
              </group>
            </SmoothedPositionGroup>
          );
        })}
      </group>
    </Canvas>
  );
}
