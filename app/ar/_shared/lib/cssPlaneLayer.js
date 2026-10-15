"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";

// CSS3DRendererはシーン内の全てのCSS3DObjectをまとめて1つのDOMレイヤーに描画する。
// 同じCanvasにHTML・動画など複数のCSS3D配置があっても、レイヤーは1つだけ作って共有する。
const cssLayersByCanvas = new WeakMap();

function acquireCssLayer(canvasElement) {
  let layer = cssLayersByCanvas.get(canvasElement);
  if (!layer) {
    const renderer = new CSS3DRenderer();
    const element = renderer.domElement;
    // WebGLのCanvasの上に重ね、操作は下のCanvas・画面側に素通しする
    Object.assign(element.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    canvasElement.parentElement?.appendChild(element);
    layer = { renderer, refCount: 0, width: -1, height: -1, lastStamp: -1 };
    cssLayersByCanvas.set(canvasElement, layer);
  }
  layer.refCount += 1;
}

function releaseCssLayer(canvasElement) {
  const layer = cssLayersByCanvas.get(canvasElement);
  if (!layer) return;
  layer.refCount -= 1;
  if (layer.refCount <= 0) {
    layer.renderer.domElement.remove();
    cssLayersByCanvas.delete(canvasElement);
  }
}

/**
 * 3Dシーンの上に重ねるCSS3Dレイヤー（DOM要素をそのまま3D空間に置く）を取得・解放し、
 * cssObject（CSS3DObject。未準備ならnull）が描画されるよう毎フレームレイヤーを描画するフック。
 * 同じフレーム内に複数のCSS3D配置があっても、レイヤーの描画は1回だけにする。
 */
export function useCssPlaneLayer(cssObject) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);

  useEffect(() => {
    const canvasElement = gl.domElement;
    acquireCssLayer(canvasElement);
    return () => releaseCssLayer(canvasElement);
  }, [gl]);

  useFrame((state) => {
    const layer = cssLayersByCanvas.get(gl.domElement);
    if (!layer || !cssObject) return;

    if (layer.width !== size.width || layer.height !== size.height) {
      layer.renderer.setSize(size.width, size.height);
      layer.width = size.width;
      layer.height = size.height;
    }

    const stamp = state.clock.elapsedTime;
    if (layer.lastStamp === stamp) return;
    layer.lastStamp = stamp;
    layer.renderer.render(state.scene, state.camera);
  });
}
