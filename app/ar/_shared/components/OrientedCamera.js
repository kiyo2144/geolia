"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { computeCameraQuaternion } from "../lib/deviceOrientationQuaternion";

/** 端末の向き(orientation)を毎フレーム three.js カメラへ反映する */
export function OrientedCamera({ orientation }) {
  const { camera } = useThree();

  useFrame(() => {
    if (!orientation) return;
    camera.quaternion.copy(computeCameraQuaternion(orientation));
  });

  return null;
}
