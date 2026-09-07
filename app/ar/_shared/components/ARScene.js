"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { latLngToLocalMeters } from "../../../_shared/lib/geoMath";
import { AnimatedGifPlaneObject } from "./AnimatedGifPlaneObject";
import { DemoPointCloud } from "./DemoPointCloud";
import { ImagePlaneObject } from "./ImagePlaneObject";
import { OrientedCamera } from "./OrientedCamera";
import { PointCloudObject } from "./PointCloudObject";
import { SparkSetup } from "./SparkSetup";
import { SplatObject } from "./SplatObject";

// 「狙い撃ち」配置モードで、3Dデータをカメラの正面何メートル先に表示するか
const AIM_DISTANCE_METERS = 2.2;

/**
 * 「配置した緯度経度」と「現在地」の差分から、3Dデータを現実の位置に
 * 対応するローカル座標（メートル単位）へ配置し続けるグループ（微調整モード用）。
 * カメラは常にワールド原点＝ユーザーの現在地として扱う。
 */
function GeoAnchoredGroup({ userPosition, targetPosition, children }) {
  const groupRef = useRef(null);

  useFrame(() => {
    if (!groupRef.current || !userPosition || !targetPosition) return;

    const { east, north } = latLngToLocalMeters(userPosition, targetPosition);
    groupRef.current.position.set(east, 0, -north);
  });

  return <group ref={groupRef}>{children}</group>;
}

/**
 * 「狙い撃ち」配置モード用のグループ。カメラの正面 AIM_DISTANCE_METERS 先に
 * 3Dデータを表示し続ける（画面中央に固定表示）。ユーザーはスマホごと動くことで
 * 大まかな設置位置を選ぶ。aimPointRef には毎フレームその地点のローカル座標(east/north)を書き込み、
 * 「ここに配置」ボタン押下時にCanvas外のReactコードから読み取れるようにする。
 */
function AimAnchoredGroup({ aimPointRef, children }) {
  const groupRef = useRef(null);
  const { camera } = useThree();
  const direction = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (!groupRef.current) return;

    camera.getWorldDirection(direction);
    const point = direction.clone().multiplyScalar(AIM_DISTANCE_METERS).add(camera.position);
    groupRef.current.position.copy(point);

    if (aimPointRef) {
      aimPointRef.current = { east: point.x, north: -point.z };
    }
  });

  return <group ref={groupRef}>{children}</group>;
}

/**
 * ジェスチャーで微調整した上下位置(y)を反映するグループ。回転・拡大縮小は
 * さらに内側のグループにのみ適用し、ここに重ねて表示するギズモ(矢印)が
 * 一緒に回転・拡大縮小されて見づらくならないようにする。
 */
function AdjustableGroup({ adjustment, gizmo, children }) {
  return (
    <group position={[0, adjustment.y, 0]}>
      <group rotation={[adjustment.rotationX, adjustment.rotationY, 0]} scale={adjustment.scale}>
        {children}
      </group>
      {gizmo}
    </group>
  );
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);

/** position方向を向く矢印(円錐)を1本描画する */
function DirectionalArrow({ position, direction, color, length = 0.16 }) {
  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(UP_AXIS, direction.clone().normalize());
    return q;
  }, [direction]);

  return (
    <mesh position={position} quaternion={quaternion}>
      <coneGeometry args={[length * 0.4, length, 12]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

const ROTATE_RING_RADIUS = 0.4;
const ROTATE_COLOR = "#ffd54a";
const VERTICAL_COLOR = "#4da6ff";
const VERTICAL_ARROW_SPAN = 0.5;

/** 左右回転(ヨー)ジェスチャー中に表示する、回転方向を示すリング状ギズモ */
function RotateGizmo({ clockwise }) {
  const sign = clockwise ? -1 : 1;

  const arrows = useMemo(() => {
    return [0, Math.PI].map((theta) => ({
      position: new THREE.Vector3(
        ROTATE_RING_RADIUS * Math.cos(theta),
        0,
        ROTATE_RING_RADIUS * Math.sin(theta),
      ),
      direction: new THREE.Vector3(-Math.sin(theta), 0, Math.cos(theta)).multiplyScalar(sign),
    }));
  }, [sign]);

  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[ROTATE_RING_RADIUS, 0.012, 8, 48]} />
        <meshBasicMaterial color={ROTATE_COLOR} transparent opacity={0.85} />
      </mesh>
      {arrows.map((arrow, index) => (
        <DirectionalArrow
          key={index}
          position={arrow.position}
          direction={arrow.direction}
          color={ROTATE_COLOR}
        />
      ))}
    </group>
  );
}

/** 上下移動ジェスチャー中に表示する、移動方向を示す矢印ギズモ */
function VerticalGizmo({ movingUp }) {
  const direction = useMemo(() => new THREE.Vector3(0, movingUp ? 1 : -1, 0), [movingUp]);

  return (
    <group>
      <mesh>
        <cylinderGeometry args={[0.01, 0.01, VERTICAL_ARROW_SPAN * 2, 8]} />
        <meshBasicMaterial color={VERTICAL_COLOR} transparent opacity={0.6} />
      </mesh>
      <DirectionalArrow
        position={new THREE.Vector3(0, movingUp ? VERTICAL_ARROW_SPAN : -VERTICAL_ARROW_SPAN, 0)}
        direction={direction}
        color={VERTICAL_COLOR}
        length={0.2}
      />
    </group>
  );
}

// React Three Fiber の <Canvas> は position/pointerEvents 等を自前のインラインstyleで
// 持っているため、外部CSSクラスでは上書きできない。style props で直接渡す必要がある。
const CANVAS_OVERLAY_STYLE = {
  position: "absolute",
  inset: 0,
  zIndex: 1,
  pointerEvents: "none",
};

export function ARScene({
  orientation,
  userPosition,
  targetPosition,
  dataUrl,
  dataFormat,
  adjustment,
  arSubMode,
  aimPointRef,
  activeGesture,
  gestureDirection,
  onVertexColorDetected,
  onSplatLoaded,
  onCanvasReady,
  decorationPresetKey,
  imageEffectKey,
}) {
  const content = (
    <>
      {dataUrl && dataFormat === "splat" && <SplatObject url={dataUrl} onLoaded={onSplatLoaded} />}
      {dataUrl && dataFormat === "ply" && (
        <PointCloudObject url={dataUrl} onVertexColorDetected={onVertexColorDetected} />
      )}
      {dataUrl && dataFormat === "image" && (
        <ImagePlaneObject
          url={dataUrl}
          decorationPresetKey={decorationPresetKey}
          imageEffectKey={imageEffectKey}
        />
      )}
      {dataUrl && dataFormat === "gif" && (
        <AnimatedGifPlaneObject
          url={dataUrl}
          decorationPresetKey={decorationPresetKey}
          imageEffectKey={imageEffectKey}
        />
      )}
      {!dataUrl && <DemoPointCloud />}
    </>
  );

  const gizmo =
    activeGesture === "rotate" ? (
      <RotateGizmo clockwise={gestureDirection < 0} />
    ) : activeGesture === "vertical" ? (
      <VerticalGizmo movingUp={gestureDirection > 0} />
    ) : null;

  return (
    <Canvas
      style={CANVAS_OVERLAY_STYLE}
      gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true }}
      camera={{ fov: 70, near: 0.01, far: 2000, position: [0, 0, 0] }}
      onCreated={({ gl }) => {
        // カメラ映像を透かして見せるため、描画バッファのクリア(背景)を完全透明にする
        gl.setClearAlpha(0);
        // プレビュー画像の撮影（canvasのdrawImage）に使うため、
        // 描画済みのcanvas要素を呼び出し元に渡す。preserveDrawingBufferを
        // 有効にしているのは、撮影がレンダーループ外（クリック時）で
        // 行われてもバッファが消去されずに残るようにするため。
        onCanvasReady?.(gl.domElement);
      }}
    >
      <OrientedCamera orientation={orientation} />
      <ambientLight intensity={1.2} />
      {dataFormat === "splat" && <SparkSetup />}

      <Suspense fallback={null}>
        {arSubMode === "aiming" ? (
          <AimAnchoredGroup aimPointRef={aimPointRef}>
            <AdjustableGroup adjustment={adjustment} gizmo={gizmo}>
              {content}
            </AdjustableGroup>
          </AimAnchoredGroup>
        ) : (
          <GeoAnchoredGroup userPosition={userPosition} targetPosition={targetPosition}>
            <AdjustableGroup adjustment={adjustment} gizmo={gizmo}>
              {content}
            </AdjustableGroup>
          </GeoAnchoredGroup>
        )}
      </Suspense>
    </Canvas>
  );
}
