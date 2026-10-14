"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { CSS3DObject, CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import {
  HTML_FRAME_HEIGHT_PX,
  HTML_FRAME_WIDTH_PX,
  HTML_MAX_DISPLAY_BYTES,
  HTML_PLANE_WIDTH_METERS,
  buildSandboxedSrcdoc,
} from "../lib/htmlSandbox";

// CSS3DRendererはシーン内の全てのCSS3DObjectをまとめて1つのDOMレイヤーに描画する。
// 同じCanvasに複数のHTML配置があっても、レイヤーは1つだけ作って共有する。
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
 * アップロードされたHTMLファイルを、AR空間内の板として「ライブ表示」する
 * （JavaScript・CSSがそのまま動作する）。
 *
 * 他の配置データ（点群・画像等）と違い、WebGLではなくDOM(CSS 3D)で描画するため、
 * 3Dオブジェクトとの前後関係（奥行きによる隠れ）は反映されず、常にWebGL描画の手前に
 * 表示される。投稿者のスクリプトを実行するため、iframeはsandbox（allow-scriptsのみ）と
 * CSPで閉じ込めている（詳細はlib/htmlSandbox.js）。操作（タップ等）には対応しない。
 */
export function HtmlPlaneObject({ url }) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const [cssObject, setCssObject] = useState(null);

  useEffect(() => {
    const canvasElement = gl.domElement;
    acquireCssLayer(canvasElement);
    return () => releaseCssLayer(canvasElement);
  }, [gl]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (cancelled) return;
        const byteLength = buffer.byteLength;

        const wrapper = document.createElement("div");
        wrapper.style.width = `${HTML_FRAME_WIDTH_PX}px`;
        wrapper.style.height = `${HTML_FRAME_HEIGHT_PX}px`;

        if (byteLength > HTML_MAX_DISPLAY_BYTES) {
          // 上限(設置時のサイズ上限)を超える大きなHTMLは、iframeは作らず、省略した旨だけを表示する。
          wrapper.style.cssText += ";display:flex;align-items:center;justify-content:center;" +
            "box-sizing:border-box;padding:32px;background:#161b22;color:#f0f3f7;" +
            "font:28px/1.6 sans-serif;text-align:center";
          wrapper.textContent =
            "このHTMLはファイルサイズが大きいため、ARでの表示を省略しています（約" +
            (byteLength / (1024 * 1024)).toFixed(1) +
            "MB）";
        } else {
          const iframe = document.createElement("iframe");
          iframe.setAttribute("sandbox", "allow-scripts");
          iframe.setAttribute("referrerpolicy", "no-referrer");
          iframe.style.cssText = [
            `width:${HTML_FRAME_WIDTH_PX}px`,
            `height:${HTML_FRAME_HEIGHT_PX}px`,
            "border:0",
            "display:block",
            "background:#fff",
          ].join(";");
          iframe.srcdoc = buildSandboxedSrcdoc(new TextDecoder().decode(buffer));
          wrapper.appendChild(iframe);
        }

        const object = new CSS3DObject(wrapper);
        // CSS3DObjectは既定でpointer-events:autoにするが、表示専用のため操作は受け付けない
        // （一人称視点のドラッグ操作などを、この板が横取りしないようにする）。
        object.element.style.pointerEvents = "none";
        // CSS 3Dのpx単位を、画像平面と同じ横幅(m)に合わせて縮小する
        object.scale.setScalar(HTML_PLANE_WIDTH_METERS / HTML_FRAME_WIDTH_PX);
        setCssObject(object);
      } catch (error) {
        console.error("HTMLの読み込みに失敗しました:", url, error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  // 同じフレーム内に複数のHTML配置があっても、レイヤーの描画は1回だけにする
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

  if (!cssObject) return null;
  return <primitive object={cssObject} />;
}
