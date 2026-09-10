// AR配置データ（点群・Gaussian Splat・静止画・GIF・VRM）のファイル形式判定・
// サイズ上限まわりの共通ロジック。カメラ経由のAR設置(ar/new)と、
// カメラを使わないデスクトップ設置(一人称視点)の両方から利用する。

const SPLAT_EXTENSIONS = ["spz", "splat", "ksplat", "sog"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

// 対応データ種別ごとのファイルサイズ上限（要件定義 docs/requirements.md 4.1.4章）
export const FILE_SIZE_LIMITS_BYTES = {
  ply: 100 * 1024 * 1024,
  splat: 50 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  gif: 20 * 1024 * 1024,
  vrm: 50 * 1024 * 1024,
};
export const FILE_SIZE_LIMIT_LABELS = {
  ply: "100MB",
  splat: "50MB",
  image: "20MB",
  gif: "20MB",
  vrm: "50MB",
};

export function getFileFormat(file) {
  if (!file) return null;
  const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : null;
}

// 拡張子から、点群(PLY)・Gaussian Splat・静止画・GIF・VRMのどれとして読むかを判定する。
// iOSの「ファイル」アプリでは、拡張子だけの独自フォーマット（.spz等）が選択できない
// （グレーアウトする）ことがあるため、accept属性を汎用バイナリにも広げて選択自体は
// できるようにしている。その分、ここで対応拡張子かどうかを厳密にチェックする。
export function getDataFormat(file) {
  const format = getFileFormat(file);
  if (!format) return null;
  if (format === "ply") return "ply";
  if (SPLAT_EXTENSIONS.includes(format)) return "splat";
  if (format === "gif") return "gif";
  if (format === "vrm") return "vrm";
  if (IMAGE_EXTENSIONS.includes(format)) return "image";
  return null;
}

// @sparkjsdev/spark の SplatFileType（文字列）に対応する拡張子ごとの値。
// アップロード直後のプレビューは拡張子の無い一時URL（blob:）を使うため、
// url任せの自動判別に頼らずこちらを明示的に渡す（詳細はSplatObject.jsのコメント参照）。
export const SPLAT_FILE_TYPE_BY_EXTENSION = {
  spz: "spz",
  splat: "splat",
  ksplat: "ksplat",
  sog: "pcsogs",
};

// 画像・GIF用の装飾フレーム／エフェクトの初期セット（要件定義 docs/requirements.md 4.1.3章）
export const DECORATION_OPTIONS = [
  { value: "none", label: "なし" },
  { value: "white", label: "シンプル白枠" },
  { value: "polaroid", label: "ポラロイド風" },
];
export const IMAGE_EFFECT_OPTIONS = [
  { value: "none", label: "なし" },
  { value: "sparkle", label: "キラキラ" },
  { value: "heart", label: "ハート" },
  { value: "confetti", label: "紙吹雪" },
];

export function getAssetType(dataFormat) {
  if (dataFormat === "splat") return "gaussian_splat";
  if (dataFormat === "image" || dataFormat === "gif") return "image";
  if (dataFormat === "vrm") return "vrm";
  return "point_cloud";
}
