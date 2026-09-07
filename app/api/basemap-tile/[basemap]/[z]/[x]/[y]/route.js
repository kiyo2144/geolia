// 背景地図タイルをサーバー側で中継する。
//
// マップエクスポート機能（GLB出力）で地形メッシュに背景地図をテクスチャとして
// 貼り付ける際、GSI/OSMのタイルサーバーがCORSヘッダーを返さないため、
// ブラウザから直接fetchしてcanvasに描画するとcanvasが汚染され
// （tainted）書き出しができなくなる。そのため、同一オリジンの
// このAPIルートを経由させることでCORS制限を回避する。
//
// 対応する要件定義: docs/requirements.md 4.6章
// タイルURLの定義は app/map/MapView.js の BASEMAP_TILES と対応している。

const BASEMAP_TILE_URLS = {
  pale: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/pale/${z}/${x}/${y}.png`,
  std: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/std/${z}/${x}/${y}.png`,
  photo: (z, x, y) =>
    `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`,
  osm: (z, x, y) => `https://a.tile.openstreetmap.org/${z}/${x}/${y}.png`,
};

export async function GET(request, { params }) {
  const { basemap, z, x, y: yWithExt } = await params;
  const buildUrl = BASEMAP_TILE_URLS[basemap];
  if (!buildUrl) {
    return new Response(null, { status: 404 });
  }
  const y = yWithExt.replace(/\.(png|jpg)$/, "");

  const upstream = await fetch(buildUrl(z, x, y), {
    headers: { "User-Agent": "geolia-map-export/1.0" },
  });
  if (!upstream.ok) {
    return new Response(null, { status: upstream.status });
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  return new Response(buffer, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
