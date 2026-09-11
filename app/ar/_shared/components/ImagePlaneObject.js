"use client";

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { ImageEffectParticles } from "./ImageEffectParticles";

// 装飾フレーム（要件定義4.1.3章「シンプル白枠」「ポラロイド風」）の余白比率
const FRAME_MARGIN_RATIO = 0.06;
const POLAROID_TOP_RATIO = 0.06;
const POLAROID_SIDE_RATIO = 0.06;
const POLAROID_BOTTOM_RATIO = 0.22;

// 画像平面の基準サイズ（横幅1メートル、高さは画像のアスペクト比から算出）
const BASE_WIDTH_METERS = 1;

/**
 * 画像本体を、選択された装飾フレーム込みでcanvasに描画する。
 * フレームなしの場合は画像をそのまま返す。
 * targetCanvas: 指定した場合、新規canvasを作らずそのcanvasに描き直す
 * （GIFアニメーションのように毎フレーム呼び出す用途で、canvas要素の量産を防ぐため）。
 */
export function buildFramedCanvas(image, decorationPresetKey, targetCanvas) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = targetCanvas ?? document.createElement("canvas");

  if (!decorationPresetKey || decorationPresetKey === "none") {
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    return canvas;
  }

  if (decorationPresetKey === "polaroid") {
    const sideMargin = Math.round(width * POLAROID_SIDE_RATIO);
    const topMargin = Math.round(width * POLAROID_TOP_RATIO);
    const bottomMargin = Math.round(width * POLAROID_BOTTOM_RATIO);
    canvas.width = width + sideMargin * 2;
    canvas.height = height + topMargin + bottomMargin;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, sideMargin, topMargin, width, height);
    return canvas;
  }

  // "white": シンプル白枠
  const margin = Math.round(width * FRAME_MARGIN_RATIO);
  canvas.width = width + margin * 2;
  canvas.height = height + margin * 2;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, margin, margin, width, height);
  return canvas;
}

/**
 * 静止画(.jpg/.png/.webp)をAR空間内の板(プレーン)として表示する。
 * decorationPresetKey: null/"none" | "white" | "polaroid"
 * imageEffectKey: null/"none" | "sparkle" | "heart" | "confetti"
 */
export function ImagePlaneObject({ url, decorationPresetKey, imageEffectKey }) {
  const [texture, setTexture] = useState(null);
  const [aspect, setAspect] = useState(1);

  useEffect(() => {
    let cancelled = false;

    // <img>によるデコードはEXIFの向き情報を常に自動反映する（主要ブラウザ共通の
    // 挙動）。createImageBitmapは環境によってimageOrientationオプションの扱いが
    // 一貫しない（常に補正される場合／されない場合がある）ため使用しない。
    // crossOriginを指定しないと、Supabase Storageの公開URL（別オリジン）から
    // 読み込んだ画像をcanvasに描画した時点でcanvasがCORS汚染され、それを
    // WebGLテクスチャ化しようとした際にSecurityErrorで失敗し何も表示されなくなる
    // （同一オリジンのblob: URL、つまり設置直後のプレビュー中は問題が起きないため
    // 見つかりにくい）。
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      const canvas = buildFramedCanvas(image, decorationPresetKey);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      setTexture(tex);
      setAspect(canvas.width / canvas.height);
    };
    image.onerror = () => {
      console.error("画像の読み込みに失敗しました:", url);
    };
    image.src = url;

    return () => {
      cancelled = true;
    };
  }, [url, decorationPresetKey]);

  const planeSize = useMemo(() => {
    const width = BASE_WIDTH_METERS;
    const height = width / aspect;
    return [width, height];
  }, [aspect]);

  if (!texture) return null;

  return (
    <group>
      <mesh>
        <planeGeometry args={planeSize} />
        <meshBasicMaterial map={texture} transparent side={THREE.DoubleSide} />
      </mesh>
      <ImageEffectParticles effectKey={imageEffectKey} planeWidth={planeSize[0]} planeHeight={planeSize[1]} />
    </group>
  );
}
