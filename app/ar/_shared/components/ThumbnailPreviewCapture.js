"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useRef, useState } from "react";
import * as THREE from "three";
import { PointCloudObject } from "./PointCloudObject";
import { SparkSetup } from "./SparkSetup";
import { SplatObject } from "./SplatObject";
import { VrmObject } from "./VrmObject";
import styles from "./ThumbnailPreviewCapture.module.css";

const BACKGROUND_COLOR = "#161b22";
// カメラの向き（正面よりやや上から）は固定し、距離だけをモデルの大きさに合わせて自動調整する
const VIEW_DIRECTION = new THREE.Vector3(0, 0.35, 1).normalize();
const FRAMING_MARGIN = 1.5;
const DEFAULT_DISTANCE = 2.4;
const ROTATE_PIXELS_TO_RADIANS = 0.012;

/**
 * 読み込んだモデルのバウンディングスフィアに合わせて、初回のみカメラ距離を
 * 自動調整する（アングル自体はVIEW_DIRECTIONで固定のまま）。調整後はロックし、
 * ユーザーが回転させてもカメラが動き続けないようにする。
 */
export function AutoFitCamera({ targetRef }) {
  const { camera } = useThree();
  const fittedRef = useRef(false);

  useFrame(() => {
    if (fittedRef.current || !targetRef.current) return;

    const box = new THREE.Box3().setFromObject(targetRef.current);
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (!sphere.radius || !Number.isFinite(sphere.radius)) return;

    const fovRadians = (camera.fov * Math.PI) / 180;
    const distance = Math.max(
      (sphere.radius * FRAMING_MARGIN) / Math.sin(fovRadians / 2),
      0.1,
    );
    const offset = VIEW_DIRECTION.clone().multiplyScalar(distance);
    camera.position.copy(sphere.center.clone().add(offset));
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
    fittedRef.current = true;
  });

  return null;
}

function SceneContent({ groupRef, dataFormat, dataUrl, splatFileType, rotationY }) {
  return (
    <group ref={groupRef} rotation={[0, rotationY, 0]}>
      {dataFormat === "splat" && <SplatObject url={dataUrl} fileType={splatFileType} />}
      {dataFormat === "ply" && <PointCloudObject url={dataUrl} />}
      {dataFormat === "vrm" && (
        <VrmObject url={dataUrl} motionPresetKey="idle" motionAssetUrl={null} />
      )}
    </group>
  );
}

/**
 * 3Dデータ（Gaussian Splat・点群・VRM）のサムネイル画像を撮影するためのプレビュー。
 * カメラ映像は使わず、固定アングル（距離のみ自動調整）でモデル単体を表示し、
 * 横方向のドラッグでモデルを回転させて好きな向きを選べるようにする。
 */
export function ThumbnailPreviewCapture({ dataFormat, dataUrl, splatFileType, onCapture }) {
  const [rotationY, setRotationY] = useState(0);
  const glRef = useRef(null);
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

  const handleCapture = useCallback(() => {
    const gl = glRef.current;
    if (!gl) return;
    gl.domElement.toBlob(
      (blob) => {
        if (blob) onCapture(blob);
      },
      "image/jpeg",
      0.85,
    );
  }, [onCapture]);

  return (
    <div className={styles.wrapper}>
      <div
        className={styles.canvasArea}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <Canvas
          gl={{ antialias: true, preserveDrawingBuffer: true }}
          camera={{ fov: 45, near: 0.01, far: 2000, position: [0, 0.4, DEFAULT_DISTANCE] }}
          onCreated={({ gl }) => {
            gl.setClearColor(BACKGROUND_COLOR, 1);
            glRef.current = gl;
          }}
        >
          <ambientLight intensity={1.2} />
          <directionalLight position={[2, 3, 2]} intensity={0.6} />
          {dataFormat === "splat" && <SparkSetup />}
          <Suspense fallback={null}>
            <SceneContent
              groupRef={groupRef}
              dataFormat={dataFormat}
              dataUrl={dataUrl}
              splatFileType={splatFileType}
              rotationY={rotationY}
            />
            <AutoFitCamera targetRef={groupRef} />
          </Suspense>
        </Canvas>
      </div>
      <p className={styles.hint}>横にドラッグして向きを調整できます</p>
      <button type="button" className={styles.captureButton} onClick={handleCapture}>
        このアングルでサムネイルを撮影
      </button>
    </div>
  );
}
