// AR配置としてYouTube動画を扱うための共通ロジック（URLの解析・保存形式・サムネイル・プレーヤー読み込み）。
// 動画ファイルそのものは保存せず、YouTubeの公式埋め込みプレーヤー（IFrame Player API）で再生する。
// 許可するのはYouTubeのURLだけで、他サイトのURLは動画IDを取り出せずに弾く（許可リスト方式）。

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com"];
// ar_data_assets.storage_path に保存する値の接頭辞（Storageのパスではなく、動画IDを入れる）
const STORAGE_PATH_PREFIX = "youtube:";

/**
 * 入力されたテキストからYouTubeの動画IDを取り出す。YouTubeのURLでなければnull。
 * 対応: youtube.com/watch?v=ID ・ youtu.be/ID ・ /shorts/ID ・ /embed/ID ・ /live/ID
 * （https:// の無い入力や、m. / www. / music. 付きのホストも受け付ける）
 */
export function parseYoutubeUrl(text) {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (YOUTUBE_HOSTS.includes(host)) {
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (first === "watch") id = url.searchParams.get("v");
    else if (["embed", "shorts", "live", "v"].includes(first)) id = second ?? null;
  }

  return id && YOUTUBE_ID_PATTERN.test(id) ? id : null;
}

export const youtubeStoragePath = (videoId) => `${STORAGE_PATH_PREFIX}${videoId}`;

/** ar_data_assets.storage_path から動画IDを取り出す（YouTubeの値でなければnull） */
export function parseYoutubeStoragePath(storagePath) {
  if (typeof storagePath !== "string" || !storagePath.startsWith(STORAGE_PATH_PREFIX)) return null;
  const id = storagePath.slice(STORAGE_PATH_PREFIX.length);
  return YOUTUBE_ID_PATTERN.test(id) ? id : null;
}

// 16:9の枠に収まる、黒帯の無いサムネイル（mqdefault: 320x180）より解像度のあるhqdefault(480x360, 上下に黒帯)を使い、
// 表示側で中央を切り抜く。
export const getYoutubeThumbnailUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
export const getYoutubeWatchUrl = (videoId) => `https://youtu.be/${videoId}`;

let apiPromise = null;

/** YouTube IFrame Player APIのスクリプトを（初回だけ）読み込み、window.YTを返す */
export function loadYoutubeIframeApi() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("ブラウザ以外では読み込めません"));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);

  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const previousHandler = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousHandler?.();
        resolve(window.YT);
      };

      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        apiPromise = null;
        reject(new Error("YouTubeプレーヤーの読み込みに失敗しました"));
      };
      document.head.appendChild(script);
    });
  }
  return apiPromise;
}
