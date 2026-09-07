import { PNG } from "pngjs";

// 国土地理院の標高タイル(dem_png)をサーバー側で取得し、MapLibreのraster-demが
// 標準対応するMapbox Terrain-RGB形式に変換して返す。
//
// GSIの標高タイルサーバーはCORSヘッダーを返さないため、ブラウザから直接
// fetchして画素値を読み取る（変換する）ことができない。そのため、同一オリジンの
// このAPIルートを経由させることでCORS制限を回避する。
//
// 対応する要件定義: docs/requirements.md 4.3.2章

const GSI_DEM_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem_png";

// 参照: https://maps.gsi.go.jp/development/demtile.html
function decodeGsiHeight(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === 0x800000) return null; // 無効値
  if (x < 0x800000) return x * 0.01;
  return (x - 0x1000000) * 0.01;
}

// Mapbox Terrain-RGB形式へのエンコード
function encodeMapboxRgb(height) {
  const value = Math.round((height + 10000) / 0.1);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export async function GET(request, { params }) {
  const { z, x, y: yWithExt } = await params;
  const y = yWithExt.replace(/\.png$/, "");

  const upstream = await fetch(`${GSI_DEM_URL}/${z}/${x}/${y}.png`);
  if (!upstream.ok) {
    return new Response(null, { status: upstream.status });
  }

  const inputBuffer = Buffer.from(await upstream.arrayBuffer());
  const png = PNG.sync.read(inputBuffer);

  for (let i = 0; i < png.data.length; i += 4) {
    const height = decodeGsiHeight(png.data[i], png.data[i + 1], png.data[i + 2]);
    const [r, g, b] = encodeMapboxRgb(height ?? 0);
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }

  const outputBuffer = PNG.sync.write(png);

  return new Response(outputBuffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
