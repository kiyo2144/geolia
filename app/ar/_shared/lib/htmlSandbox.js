// アップロードされたHTMLファイルをAR空間内に表示する際の、サンドボックス化まわりの共通ロジック。
// 投稿者のスクリプトがそのまま他のユーザーの端末で実行されるため、iframeのsandbox属性
// （allow-same-originを付けない＝アプリのCookie・ストレージ・DOMに触れない）と、
// 外部通信を原則禁止するCSP（許可するのは下記の公開CDNのみ）の二重で閉じ込める。

// 表示用iframeの内部サイズ(px)。AR空間では画像平面と同じ横幅(HTML_PLANE_WIDTH_METERS)に
// 合わせて縮小して表示する（スケールはHtmlPlaneObject側で掛ける）。
// iPhone（画面倍率3倍）では、iframe内のWebGLの描画ピクセル数がこの縦横の9倍になり、
// 大きいと負荷でページごと強制終了されたため、読める範囲で小さめにしている。
export const HTML_FRAME_WIDTH_PX = 640;
export const HTML_FRAME_HEIGHT_PX = 480;
// これを超えるHTMLは、ライブ表示せず代わりの案内を表示する。設置時のサイズ上限
// （dataFormat.jsのhtml: 5MB）に合わせており、通常は超えない（それ以前のデータや
// 将来の上限変更への安全弁）。実測では、画像を埋め込んだ4MB台の2Dキャンバスのページは
// 問題なく動く一方、負荷が大きいのはWebGLのシェーダー等の描画解像度だったため、
// ファイルサイズではなく下記の描画解像度の固定で負荷を抑えている。
export const HTML_MAX_DISPLAY_BYTES = 5 * 1024 * 1024;
export const HTML_PLANE_WIDTH_METERS = 1;

// Three.jsなどのライブラリを読み込むHTMLを動かすため、読み込みだけを許可する公開CDN。
// 任意のサーバーへの通信（データの持ち出し）は許可しない。ここに載せたホストは
// スクリプト・スタイル・画像・フォント・fetch(モデル/テクスチャ)の取得に使える。
const TRUSTED_CDN_HOSTS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
  // three.js公式のビルド・サンプル用テクスチャ
  "https://threejs.org",
];
const GOOGLE_FONTS_STYLE_HOST = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILE_HOST = "https://fonts.gstatic.com";

const SANDBOX_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${TRUSTED_CDN_HOSTS.join(" ")}`,
  `style-src 'unsafe-inline' ${[GOOGLE_FONTS_STYLE_HOST, ...TRUSTED_CDN_HOSTS].join(" ")}`,
  `img-src data: blob: ${TRUSTED_CDN_HOSTS.join(" ")}`,
  `font-src data: ${[GOOGLE_FONTS_FILE_HOST, ...TRUSTED_CDN_HOSTS].join(" ")}`,
  `media-src data: blob: ${TRUSTED_CDN_HOSTS.join(" ")}`,
  `connect-src ${TRUSTED_CDN_HOSTS.join(" ")}`,
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// 文書の先頭に差し込む、iframe内で動くスクリプト。(1)描画解像度の固定と、(2)読み込みが
// ブロックされた・スクリプトエラーが出た場合に、黒い画面のまま原因が分からなくならない
// よう、iframe内の左上に小さく理由を表示する。iframeの外（アプリ側）からはsandboxの
// 中身を見られないため、内側で検知する。
const DIAGNOSTIC_SCRIPT = `
// iPhone(画面倍率3倍)ではcanvas/WebGLの描画ピクセル数が縦横の9倍になり、全画面シェーダー等が
// GPU負荷でページごと強制終了される原因になるため、ページ側が参照するdevicePixelRatioを1に固定する
// （AR空間内では板が小さく表示されるため、見た目の差はわずか）。
try {
  Object.defineProperty(window, "devicePixelRatio", { get: function () { return 1; } });
} catch (e) {}
(function () {
  var messages = [];
  var banner = null;
  function render() {
    if (!document.documentElement) return;
    if (!banner) {
      banner = document.createElement("div");
      banner.setAttribute("style", "position:fixed;left:0;top:0;z-index:2147483647;max-width:100%;box-sizing:border-box;padding:6px 10px;background:rgba(160,20,20,.88);color:#fff;font:12px/1.5 sans-serif;white-space:pre-wrap;word-break:break-all;pointer-events:none");
      document.documentElement.appendChild(banner);
    }
    banner.textContent = messages.join("\\n");
  }
  function add(text) {
    if (messages.indexOf(text) !== -1 || messages.length >= 3) return;
    messages.push(text);
    render();
  }
  document.addEventListener("securitypolicyviolation", function (event) {
    add("読み込みがブロックされました: " + (event.blockedURI || event.violatedDirective));
  });
  window.addEventListener("error", function (event) {
    add("スクリプトエラー: " + (event.message || "不明なエラー"));
  });
})();
`;

/**
 * HTMLテキストを、iframeのsrcdocに渡せるサンドボックス用の文書に変換する。
 * CSPのmetaタグを必ず<head>の先頭に入れる必要があるため、文字列の置換ではなく
 * 一度パースしてから先頭に挿入する（DOMParserはスクリプトを実行しない）。
 * こうしないと、<head>より前に書かれたスクリプトがCSP適用前に実行されてしまう。
 */
export function buildSandboxedSrcdoc(htmlText) {
  const parsed = new DOMParser().parseFromString(htmlText, "text/html");

  // 外部へ遷移させるrefreshと、相対URLの基準を書き換える<base>は取り除く
  parsed.querySelectorAll("base, meta[http-equiv='refresh' i]").forEach((element) => element.remove());

  // 先頭から順に「CSP → 診断スクリプト → 投稿者の内容」になるよう、後ろから差し込む
  const diagnostic = parsed.createElement("script");
  diagnostic.textContent = DIAGNOSTIC_SCRIPT;
  parsed.head.prepend(diagnostic);

  const meta = parsed.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", SANDBOX_CSP);
  parsed.head.prepend(meta);

  return `<!DOCTYPE html>${parsed.documentElement.outerHTML}`;
}
