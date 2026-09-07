"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildFramedCanvas } from "./ImagePlaneObject";
import { ImageEffectParticles } from "./ImageEffectParticles";

const BASE_WIDTH_METERS = 1;

/**
 * gifuct-jsのデコード結果(1フレーム分)を、累積フレームcanvas上に合成する。
 * disposalType === 2 の場合はそのフレーム領域を次に描画する前にクリアする
 * （GIF仕様上「背景色に戻す」指示のため）。
 */
function drawFrameToCanvas(ctx, frame, pendingClear) {
  if (pendingClear) {
    ctx.clearRect(pendingClear.left, pendingClear.top, pendingClear.width, pendingClear.height);
  }

  const { dims, patch } = frame;
  const imageData = new ImageData(patch, dims.width, dims.height);
  const patchCanvas = document.createElement("canvas");
  patchCanvas.width = dims.width;
  patchCanvas.height = dims.height;
  patchCanvas.getContext("2d").putImageData(imageData, 0, 0);
  ctx.drawImage(patchCanvas, dims.left, dims.top);
}

/**
 * GIFアニメーションをAR空間内の板(プレーン)として表示する。
 * gifuct-jsで全フレームを事前デコードし、各フレームのdelay(ms)に従って
 * useFrame内でテクスチャを差し替える。テクスチャ・累積フレームcanvasは
 * レンダーをまたいで書き換え続ける必要があるため、refで保持する。
 */
export function AnimatedGifPlaneObject({ url, decorationPresetKey, imageEffectKey }) {
  // 初回表示用のtexture/planeSizeはstateで保持する。以降の毎フレーム更新は、
  // このstate変数自体を書き換えるのではなく、materialRef経由(materialRef.current.map)で
  // 行う（three.jsオブジェクトをrefの先で書き換えるR3Fの標準パターン）。
  const [texture, setTexture] = useState(null);
  const [planeSize, setPlaneSize] = useState(null);

  const materialRef = useRef(null);
  const framesRef = useRef(null);
  const frameCanvasRef = useRef(null);
  const animRef = useRef({ frameIndex: 0, elapsedMs: 0 });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { parseGIF, decompressFrames } = await import("gifuct-js");
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      const gif = parseGIF(buffer);
      const frames = decompressFrames(gif, true);
      if (cancelled || !frames.length) return;

      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = gif.lsd.width;
      frameCanvas.height = gif.lsd.height;
      drawFrameToCanvas(frameCanvas.getContext("2d"), frames[0], null);

      const outputCanvas = buildFramedCanvas(frameCanvas, decorationPresetKey);
      const tex = new THREE.CanvasTexture(outputCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;

      framesRef.current = frames;
      frameCanvasRef.current = frameCanvas;
      animRef.current = { frameIndex: 0, elapsedMs: 0 };

      setTexture(tex);
      setPlaneSize([
        BASE_WIDTH_METERS,
        (BASE_WIDTH_METERS * outputCanvas.height) / outputCanvas.width,
      ]);
    })();

    return () => {
      cancelled = true;
    };
  }, [url, decorationPresetKey]);

  useFrame((_state, delta) => {
    const material = materialRef.current;
    const frames = framesRef.current;
    const frameCanvas = frameCanvasRef.current;
    if (!material?.map || !frames || !frameCanvas) return;

    const anim = animRef.current;
    anim.elapsedMs += delta * 1000;
    const currentFrame = frames[anim.frameIndex];
    const delay = currentFrame.delay > 0 ? currentFrame.delay : 100;
    if (anim.elapsedMs < delay) return;
    anim.elapsedMs = 0;

    const pendingClear = currentFrame.disposalType === 2 ? currentFrame.dims : null;
    anim.frameIndex = (anim.frameIndex + 1) % frames.length;

    drawFrameToCanvas(frameCanvas.getContext("2d"), frames[anim.frameIndex], pendingClear);

    material.map.image = buildFramedCanvas(frameCanvas, decorationPresetKey);
    material.map.needsUpdate = true;
  });

  if (!texture || !planeSize) return null;

  return (
    <group>
      <mesh>
        <planeGeometry args={planeSize} />
        <meshBasicMaterial ref={materialRef} map={texture} transparent side={THREE.DoubleSide} />
      </mesh>
      <ImageEffectParticles effectKey={imageEffectKey} planeWidth={planeSize[0]} planeHeight={planeSize[1]} />
    </group>
  );
}
