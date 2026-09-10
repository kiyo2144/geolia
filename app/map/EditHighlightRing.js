"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

const RING_INNER_RADIUS_METERS = 0.6;
const RING_OUTER_RADIUS_METERS = 0.8;
const PULSE_SPEED = 2.5;
const PULSE_MIN_OPACITY = 0.35;
const PULSE_MAX_OPACITY = 0.85;

/**
 * 編集中のAR配置をひと目で判別できるよう、地面に青いリングを表示する。
 * 配置の種類（画像・VRM・点群等）を問わず使えるよう、中身のメッシュには手を
 * 加えず、地面位置に独立した輪をオーバーレイする方式にしている。
 */
export function EditHighlightRing({ position }) {
  const materialRef = useRef(null);

  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (!material) return;
    const pulse = (Math.sin(clock.elapsedTime * PULSE_SPEED) + 1) / 2;
    material.opacity = PULSE_MIN_OPACITY + pulse * (PULSE_MAX_OPACITY - PULSE_MIN_OPACITY);
  });

  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]} renderOrder={998}>
      <ringGeometry args={[RING_INNER_RADIUS_METERS, RING_OUTER_RADIUS_METERS, 48]} />
      <meshBasicMaterial
        ref={materialRef}
        color="#3b82f6"
        transparent
        opacity={PULSE_MAX_OPACITY}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
