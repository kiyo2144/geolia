"use client";

import { useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";

// 要件定義 docs/requirements.md 4.1.3章「画像用エフェクト」の初期セット
// （キラキラ・ハート・紙吹雪・なし）を、three.jsのPoints（常にカメラを向く板）で表現する。

const PARTICLE_COUNT = 20;

function buildSpriteCanvas(drawFn) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.translate(32, 32);
  drawFn(ctx);
  return canvas;
}

function drawStar(ctx) {
  ctx.fillStyle = "#fff6b0";
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.rotate((Math.PI / 2) * i + Math.PI / 4);
    ctx.beginPath();
    ctx.moveTo(0, -28);
    ctx.lineTo(6, -6);
    ctx.lineTo(28, 0);
    ctx.lineTo(6, 6);
    ctx.lineTo(0, 28);
    ctx.lineTo(-6, 6);
    ctx.lineTo(-28, 0);
    ctx.lineTo(-6, -6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawHeart(ctx) {
  ctx.fillStyle = "#ff5c8a";
  ctx.beginPath();
  ctx.moveTo(0, 10);
  ctx.bezierCurveTo(-24, -14, -26, -30, -8, -30);
  ctx.bezierCurveTo(0, -30, 0, -20, 0, -14);
  ctx.bezierCurveTo(0, -20, 0, -30, 8, -30);
  ctx.bezierCurveTo(26, -30, 24, -14, 0, 10);
  ctx.closePath();
  ctx.fill();
}

function drawPetal(ctx) {
  const colors = ["#ff8fa3", "#ffd166", "#8ecae6", "#95d5b2"];
  ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
  ctx.beginPath();
  ctx.ellipse(0, 0, 22, 12, 0, 0, Math.PI * 2);
  ctx.fill();
}

const EFFECT_CONFIG = {
  sparkle: { draw: drawStar, size: 0.06 },
  heart: { draw: drawHeart, size: 0.08 },
  confetti: { draw: drawPetal, size: 0.07 },
};

/**
 * 画像・GIFの周りに表示する簡易エフェクト。effectKeyが未指定(null)または
 * 'none'の場合は何も表示しない。
 */
export function ImageEffectParticles({ effectKey, planeWidth = 1, planeHeight = 1 }) {
  const config = effectKey ? EFFECT_CONFIG[effectKey] : null;

  // Math.random()での配置初期化は、useState()の遅延初期化関数内でのみ
  // 一度だけ実行することが許容されるため、useMemoではなくこちらを使う。
  const [texture] = useState(() => {
    if (!config) return null;
    return new THREE.CanvasTexture(buildSpriteCanvas(config.draw));
  });

  const [geometry] = useState(() => {
    if (!config) return null;
    const spread = Math.max(planeWidth, planeHeight) * 0.8;
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const seeds = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * spread * 2;
      positions[i * 3 + 1] = (Math.random() - 0.5) * spread * 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 0.15;
      seeds[i] = Math.random() * Math.PI * 2;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.userData.basePositions = positions.slice();
    geom.userData.seeds = seeds;
    return geom;
  });

  const pointsRef = useRef(null);

  useFrame(({ clock }) => {
    if (!geometry || !pointsRef.current) return;
    const t = clock.getElapsedTime();
    const posAttr = pointsRef.current.geometry.attributes.position;
    const { basePositions, seeds } = pointsRef.current.geometry.userData;

    for (let i = 0; i < posAttr.count; i++) {
      const seed = seeds[i];
      const baseX = basePositions[i * 3];
      const baseY = basePositions[i * 3 + 1];
      const baseZ = basePositions[i * 3 + 2];

      if (effectKey === "confetti") {
        // 上から下へ舞い落ちる
        const span = Math.max(planeWidth, planeHeight) * 1.6;
        posAttr.setY(i, ((baseY + span / 2 - t * 0.3 + seed) % span) - span / 2);
        posAttr.setX(i, baseX + Math.sin(t * 1.3 + seed) * 0.04);
      } else if (effectKey === "heart") {
        // ふわふわ上へ舞う
        const span = Math.max(planeWidth, planeHeight) * 1.4;
        posAttr.setY(i, ((baseY + span / 2 + t * 0.2 + seed) % span) - span / 2);
        posAttr.setX(i, baseX + Math.sin(t * 0.9 + seed) * 0.05);
      } else {
        // キラキラ: その場で小さく揺れる
        posAttr.setX(i, baseX + Math.sin(t * 1.6 + seed) * 0.03);
        posAttr.setY(i, baseY + Math.cos(t * 1.4 + seed) * 0.03);
      }
      posAttr.setZ(i, baseZ);
    }
    posAttr.needsUpdate = true;
  });

  if (!config) return null;

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        map={texture}
        size={config.size}
        transparent
        depthWrite={false}
        sizeAttenuation
      />
    </points>
  );
}
