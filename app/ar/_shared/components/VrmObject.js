"use client";

import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// VRM定型モーション（要件定義 docs/requirements.md 4.1.3章: 待機・手を振る・お辞儀・ジャンプ）は
// 素材ファイルを用意せず、VRMのHumanoidボーンを直接動かす自作のプロシージャルアニメーションとして
// 実装する（モーション素材の入手方法は「自作」を採用）。
// ボーンの角度はnormalized boneのrest pose（T字姿勢）を基準にした相対値（ラジアン）。

const ARM_DOWN_Z = 1.2; // T-pose(水平に伸ばした腕)から自然に下ろすための回転量
// normalized boneでのZ軸回転は、leftUpperArmが負・rightUpperArmが正の向きで
// 腕が下がる（実機確認: 符号を逆にすると腕がT-poseから上がってしまう）。

function setBoneRotation(vrm, name, x = 0, y = 0, z = 0) {
  const bone = vrm.humanoid?.getNormalizedBoneNode(name);
  if (!bone) return;
  bone.rotation.set(x, y, z);
}

function applyIdleMotion(vrm, t) {
  setBoneRotation(vrm, "leftUpperArm", 0, 0, -(ARM_DOWN_Z + Math.sin(t * 1.4) * 0.02));
  setBoneRotation(vrm, "rightUpperArm", 0, 0, ARM_DOWN_Z + Math.sin(t * 1.4) * 0.02);
  setBoneRotation(vrm, "spine", Math.sin(t * 1.4) * 0.02);
  setBoneRotation(vrm, "head", 0, Math.sin(t * 0.6) * 0.05);
  const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
  if (hips) hips.position.y = Math.sin(t * 1.4) * 0.01;
}

function applyWaveMotion(vrm, t) {
  setBoneRotation(vrm, "leftUpperArm", 0, 0, -ARM_DOWN_Z);
  setBoneRotation(vrm, "rightUpperArm", 0.2, 0, -0.3);
  setBoneRotation(vrm, "rightLowerArm", 0, -1.6, 0);
  setBoneRotation(vrm, "rightHand", 0, 0, Math.sin(t * 6) * 0.5);
  setBoneRotation(vrm, "spine", 0, Math.sin(t * 6) * 0.03);
}

function applyBowMotion(vrm, t) {
  setBoneRotation(vrm, "leftUpperArm", 0, 0, -ARM_DOWN_Z);
  setBoneRotation(vrm, "rightUpperArm", 0, 0, ARM_DOWN_Z);
  // 0→1→0を約2.5秒周期で繰り返す（前傾してから戻る）
  const cycle = (Math.sin((t * Math.PI * 2) / 2.5 - Math.PI / 2) + 1) / 2;
  const bowAngle = cycle * 0.6;
  setBoneRotation(vrm, "spine", bowAngle * 0.6);
  setBoneRotation(vrm, "chest", bowAngle * 0.4);
  setBoneRotation(vrm, "head", bowAngle * 0.2);
}

function applyJumpMotion(vrm, t) {
  const cyclePos = t % 1; // 1秒周期
  const jumpHeight = Math.max(0, Math.sin(cyclePos * Math.PI));
  const squat = Math.max(0, -Math.sin(cyclePos * Math.PI * 2)) * 0.3;
  const legBend = squat + (1 - jumpHeight) * 0.05;

  setBoneRotation(vrm, "leftUpperArm", 0, 0, -(ARM_DOWN_Z - jumpHeight * 0.8));
  setBoneRotation(vrm, "rightUpperArm", 0, 0, ARM_DOWN_Z - jumpHeight * 0.8);
  setBoneRotation(vrm, "leftUpperLeg", legBend);
  setBoneRotation(vrm, "rightUpperLeg", legBend);
  setBoneRotation(vrm, "leftLowerLeg", -legBend * 1.6);
  setBoneRotation(vrm, "rightLowerLeg", -legBend * 1.6);

  const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
  if (hips) hips.position.y = jumpHeight * 0.25;
}

const MOTION_PRESET_HANDLERS = {
  idle: applyIdleMotion,
  wave: applyWaveMotion,
  bow: applyBowMotion,
  jump: applyJumpMotion,
};

/** 定型モーション（プロシージャルアニメーション）を毎フレーム適用する */
function PresetMotionPlayer({ vrm, presetKey }) {
  useFrame((state, delta) => {
    const handler = MOTION_PRESET_HANDLERS[presetKey] ?? applyIdleMotion;
    handler(vrm, state.clock.elapsedTime);
    vrm.update(delta);
  });
  return null;
}

/** ユーザーがアップロードしたモーションファイル(.vrma)を読み込み、AnimationMixerで再生する */
function UploadedMotionPlayer({ vrm, url }) {
  const gltf = useLoader(GLTFLoader, url, (loader) => {
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  });
  const mixerRef = useRef(null);

  useEffect(() => {
    const vrmAnimation = gltf.userData.vrmAnimations?.[0];
    if (!vrmAnimation) return;

    const clip = createVRMAnimationClip(vrmAnimation, vrm);
    const mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.clipAction(clip).play();
    mixerRef.current = mixer;

    return () => {
      mixer.stopAllAction();
      mixerRef.current = null;
    };
  }, [gltf, vrm]);

  useFrame((_state, delta) => {
    mixerRef.current?.update(delta);
    vrm.update(delta);
  });
  return null;
}

/**
 * VRMを人型アバターとして表示する（要件定義 docs/requirements.md 4.1.2章）。
 * motionAssetUrl（ユーザーアップロードの.vrmaファイル）が指定されていればそちらを優先し、
 * 無ければmotionPresetKey（定型モーション）のプロシージャルアニメーションを再生する。
 */
export function VrmObject({ url, motionPresetKey, motionAssetUrl }) {
  const gltf = useLoader(GLTFLoader, url, (loader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });

  const vrm = gltf.userData.vrm;

  useEffect(() => {
    if (!vrm) return;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.humanoid?.resetNormalizedPose();
  }, [gltf, vrm]);

  if (!vrm) return null;

  return (
    <group>
      <primitive object={vrm.scene} />
      {motionAssetUrl ? (
        <UploadedMotionPlayer vrm={vrm} url={motionAssetUrl} />
      ) : (
        <PresetMotionPlayer vrm={vrm} presetKey={motionPresetKey} />
      )}
    </group>
  );
}
