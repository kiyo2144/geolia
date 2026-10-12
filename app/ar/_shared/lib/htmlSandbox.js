// アップロードされたHTMLファイルをAR空間内に表示する際の、サンドボックス化まわりの共通ロジック。
// 投稿者のスクリプトがそのまま他のユーザーの端末で実行されるため、iframeのsandbox属性
// （allow-same-originを付けない＝アプリのCookie・ストレージ・DOMに触れない）と、
// 外部通信を全て禁止するCSPの二重で閉じ込める。

// 表示用iframeの内部サイズ(px)。AR空間では画像平面と同じ横幅(HTML_PLANE_WIDTH_METERS)に
// 合わせて縮小して表示する（スケールはHtmlPlaneObject側で掛ける）。
export const HTML_FRAME_WIDTH_PX = 1024;
export const HTML_FRAME_HEIGHT_PX = 768;
export const HTML_PLANE_WIDTH_METERS = 1;

// 外部への通信・外部リソースの読み込みを一切許可しない。インラインのscript/styleと、
// data:/blob:の画像・フォント・メディアだけを許可する（単一ファイルで完結するHTML向け）。
const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

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

  const meta = parsed.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", SANDBOX_CSP);
  parsed.head.prepend(meta);

  return `<!DOCTYPE html>${parsed.documentElement.outerHTML}`;
}
