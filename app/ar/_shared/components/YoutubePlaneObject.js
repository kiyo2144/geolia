"use client";

import { useEffect, useMemo, useRef } from "react";
import { CSS3DObject } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import { useCssPlaneLayer } from "../lib/cssPlaneLayer";
import { getYoutubeThumbnailUrl, loadYoutubeIframeApi } from "../lib/youtube";

// 表示用の枠の内部サイズ(px)。AR空間では横幅1mに縮小して表示する（YouTubeのプレーヤーは16:9）。
// iPhoneでHTMLのライブ表示を複数動かして強制終了した経緯から、動画も同時に動かす数を1つに絞っている。
const FRAME_WIDTH_PX = 640;
const FRAME_HEIGHT_PX = 360;
const PLANE_WIDTH_METERS = 1;

const PLAY_BADGE_SVG =
  '<svg viewBox="0 0 120 120" width="120" height="120" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="60" cy="60" r="56" fill="rgba(13,17,23,0.72)" stroke="#fff" stroke-width="4"/>' +
  '<path d="M48 36 L48 84 L88 60 Z" fill="#fff"/></svg>';

// YouTubeプレーヤーのエラーコード → 表示する理由
const ERROR_MESSAGES = {
  2: "動画のURLが正しくありません",
  5: "この動画は再生できませんでした",
  100: "この動画は見つからないか、非公開です",
  101: "この動画は埋め込み再生が許可されていません",
  150: "この動画は埋め込み再生が許可されていません",
};

// 同時に再生するプレーヤーは1つだけ。別の動画の再生を始めたとき、前のプレーヤーをサムネイル表示に戻す。
let releaseActivePlayer = null;

/** サムネイル・再生アイコン・プレーヤーを載せる枠のDOMを組み立てる（再生中の表示はプレーヤー側が行う） */
function createYoutubeView(videoId) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText =
    `position:relative;width:${FRAME_WIDTH_PX}px;height:${FRAME_HEIGHT_PX}px;` +
    "background:#000;overflow:hidden;font-family:sans-serif";

  const thumbnail = document.createElement("img");
  thumbnail.alt = "";
  thumbnail.src = getYoutubeThumbnailUrl(videoId);
  thumbnail.referrerPolicy = "no-referrer";
  thumbnail.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";

  // 再生アイコン（待機中・エラー時に表示。エラー時は理由も表示する）
  const badge = document.createElement("div");
  badge.style.cssText =
    "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:16px;pointer-events:none";
  badge.innerHTML = PLAY_BADGE_SVG;
  const message = document.createElement("div");
  message.style.cssText =
    "display:none;max-width:520px;padding:10px 18px;border-radius:10px;" +
    "background:rgba(160,20,20,0.9);color:#fff;font-size:24px;line-height:1.5;text-align:center";
  badge.appendChild(message);

  const mount = document.createElement("div");
  mount.style.cssText = "position:absolute;inset:0";

  wrapper.append(thumbnail, badge, mount);

  const object = new CSS3DObject(wrapper);
  // CSS3DObjectは既定でpointer-events:autoにするが、操作は画面のボタンから行うため
  // この板は操作を受け付けない（調整モードのタップ・ドラッグを横取りしないようにする）。
  object.element.style.pointerEvents = "none";
  object.scale.setScalar(PLANE_WIDTH_METERS / FRAME_WIDTH_PX);

  return { object, badge, message, mount };
}

// 再生状態に合わせて、サムネイル上の再生アイコン・エラー表示を切り替える
function applyViewState({ badge, message }, status, errorMessage) {
  // 動画が出ている間（再生中・一時停止中）はアイコンを隠す。読み込み中は進行中が分かるよう薄く出す。
  const isVideoVisible = status === "playing" || status === "paused";
  badge.style.display = isVideoVisible ? "none" : "flex";
  badge.style.opacity = status === "loading" ? "0.5" : "1";
  message.style.display = status === "error" ? "block" : "none";
  message.textContent = status === "error" ? (errorMessage ?? "") : "";
}

/**
 * YouTube動画を、AR空間内の板として表示する（CSS 3D。HTMLのライブ表示と同じ仕組み）。
 * 初期状態はサムネイルのみで、再生操作が来たときだけ公式の埋め込みプレーヤーを読み込む
 * （iPhoneの自動再生制限・端末負荷への対策。再生はミュートで始める）。
 *
 * 操作はAR閲覧画面側のボタンから行う。videoControllersRef（Map）にplacementIdをキーとして
 * 操作用のコントローラを登録し、状態の変化はonVideoStateChange(placementId, state)で通知する。
 * どちらも省略した場合は、サムネイルを表示するだけ（再生しない）。
 *
 * state: { status: "idle" | "loading" | "playing" | "paused" | "error", muted, error }
 */
export function YoutubePlaneObject({
  videoId,
  placementId = null,
  videoControllersRef = null,
  onVideoStateChange = null,
}) {
  const view = useMemo(() => createYoutubeView(videoId), [videoId]);
  useCssPlaneLayer(view.object);

  const onStateChangeRef = useRef(onVideoStateChange);
  useEffect(() => {
    onStateChangeRef.current = onVideoStateChange;
  });

  useEffect(() => {
    const { mount } = view;
    let player = null;
    let status = "idle";
    let muted = true;
    let errorMessage = null;
    let disposed = false;

    const snapshot = () => ({ status, muted, error: errorMessage });
    const notify = () => onStateChangeRef.current?.(placementId, snapshot());

    const render = () => applyViewState(view, status, errorMessage);

    const setStatus = (next) => {
      status = next;
      render();
      notify();
    };

    const destroyPlayer = () => {
      if (player) {
        try {
          player.destroy();
        } catch {
          // 既に破棄されている場合は何もしない
        }
        player = null;
      }
      mount.replaceChildren();
    };

    // 他の動画の再生が始まったときなど、サムネイル表示（待機）に戻す
    const release = () => {
      destroyPlayer();
      errorMessage = null;
      muted = true;
      setStatus("idle");
    };

    const start = async () => {
      if (disposed || status === "loading") return;
      if (releaseActivePlayer && releaseActivePlayer !== release) releaseActivePlayer();
      releaseActivePlayer = release;
      errorMessage = null;
      muted = true;
      setStatus("loading");

      try {
        const YT = await loadYoutubeIframeApi();
        if (disposed) return;
        const node = document.createElement("div");
        mount.appendChild(node);
        player = new YT.Player(node, {
          width: FRAME_WIDTH_PX,
          height: FRAME_HEIGHT_PX,
          videoId,
          host: "https://www.youtube-nocookie.com",
          playerVars: {
            autoplay: 1,
            mute: 1,
            controls: 0,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            iv_load_policy: 3,
            fs: 0,
            disablekb: 1,
          },
          events: {
            onReady: (event) => event.target.playVideo(),
            onStateChange: (event) => {
              const states = YT.PlayerState;
              if (event.data === states.PLAYING) setStatus("playing");
              else if (event.data === states.PAUSED) setStatus("paused");
              else if (event.data === states.ENDED) release();
              else if (event.data === states.BUFFERING && status !== "playing" && status !== "paused") {
                setStatus("loading");
              }
            },
            onError: (event) => {
              destroyPlayer();
              errorMessage = ERROR_MESSAGES[event.data] ?? "この動画は再生できませんでした";
              setStatus("error");
            },
          },
        });
      } catch (error) {
        destroyPlayer();
        errorMessage = error.message ?? "動画を読み込めませんでした";
        setStatus("error");
      }
    };

    const controller = {
      getState: snapshot,
      playPause() {
        if (status === "playing") player?.pauseVideo();
        else if (status === "paused") player?.playVideo();
        else if (status === "idle" || status === "error") start();
      },
      toggleMute() {
        if (!player || (status !== "playing" && status !== "paused")) return;
        if (player.isMuted()) {
          player.unMute();
          muted = false;
        } else {
          player.mute();
          muted = true;
        }
        notify();
      },
      seekBy(seconds) {
        if (!player || (status !== "playing" && status !== "paused")) return;
        player.seekTo(Math.max(0, player.getCurrentTime() + seconds), true);
      },
    };

    render();
    const controllers = videoControllersRef?.current;
    if (controllers && placementId !== null) controllers.set(placementId, controller);

    return () => {
      disposed = true;
      destroyPlayer();
      if (releaseActivePlayer === release) releaseActivePlayer = null;
      if (controllers && placementId !== null && controllers.get(placementId) === controller) {
        controllers.delete(placementId);
      }
      onStateChangeRef.current?.(placementId, null);
    };
  }, [view, videoId, placementId, videoControllersRef]);

  return <primitive object={view.object} />;
}
