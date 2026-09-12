import { NextResponse } from "next/server";

// JARTIC（日本道路交通情報センター）のオープン交通量データAPIを中継する。
// このAPIはCORSヘッダーを返さないため、ブラウザから直接fetchできず
// （実機で直接確認済み）、同一オリジンのこのAPIルート経由にする必要がある
// （地理院タイルをapi/dem-tile経由にしているのと同じ理由）。
// 仕様書「交通量API仕様書」1-1章に基づく（様式1: 常時観測データ計測値・5分値）。

const JARTIC_BASE_URL = "https://api.jartic-open-traffic.org/geoserver";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
// 「観測後概ね20分後に提供」との記載があるため、最新時刻ちょうどをリクエストすると
// まだデータが無いことがある。余裕を持たせた時刻を起点に、REQUEST_WINDOW_MINUTES分の
// 範囲で取得し、観測点ごとに最新の1件だけを採用する。
const DATA_PUBLISH_LAG_MINUTES = 25;
const REQUEST_WINDOW_MINUTES = 25;

// 上り・下りそれぞれ、小型・大型・車種判別不能の3種を合算して「台数」として扱う
const UP_FIELDS = ["上り・小型交通量", "上り・大型交通量", "上り・車種判別不能交通量"];
const DOWN_FIELDS = ["下り・小型交通量", "下り・大型交通量", "下り・車種判別不能交通量"];

const ROAD_TYPE_LABELS = { 1: "高速自動車国道", 3: "一般国道" };

function formatTimeCode(date) {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}${mo}${d}${h}${mi}`;
}

function roundDownToFiveMinutes(date) {
  const rounded = new Date(date);
  rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / 5) * 5, 0, 0);
  return rounded;
}

function sumFields(properties, fields) {
  return fields.reduce((sum, field) => {
    const value = properties[field];
    return typeof value === "number" ? sum + value : sum;
  }, 0);
}

// レスポンスは観測点ごとに複数時刻ぶんのレコードを含み得るため、
// 常時観測点コードごとに時間コードが最も新しい1件だけを残す。
function keepLatestPerPoint(features) {
  const latestByPoint = new Map();
  for (const feature of features) {
    const p = feature.properties;
    const pointCode = p["常時観測点コード"];
    const timeCode = p["時間コード"];
    const existing = latestByPoint.get(pointCode);
    if (!existing || timeCode > existing.properties["時間コード"]) {
      latestByPoint.set(pointCode, feature);
    }
  }
  return [...latestByPoint.values()];
}

function toSimplifiedFeature(feature) {
  const p = feature.properties;
  return {
    type: "Feature",
    geometry: feature.geometry,
    properties: {
      pointCode: p["常時観測点コード"],
      roadType: p["道路種別"],
      roadTypeLabel: ROAD_TYPE_LABELS[p["道路種別"]] ?? `道路種別${p["道路種別"]}`,
      timeCode: p["時間コード"],
      upTotal: sumFields(p, UP_FIELDS),
      downTotal: sumFields(p, DOWN_FIELDS),
    },
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const minLng = searchParams.get("minLng");
  const minLat = searchParams.get("minLat");
  const maxLng = searchParams.get("maxLng");
  const maxLat = searchParams.get("maxLat");

  if (!minLng || !minLat || !maxLng || !maxLat) {
    return NextResponse.json({ error: "minLng/minLat/maxLng/maxLatが必要です" }, { status: 400 });
  }

  const nowJst = new Date(Date.now() + JST_OFFSET_MS);
  const endTime = roundDownToFiveMinutes(
    new Date(nowJst.getTime() - DATA_PUBLISH_LAG_MINUTES * 60 * 1000),
  );
  const startTime = new Date(endTime.getTime() - REQUEST_WINDOW_MINUTES * 60 * 1000);

  const cqlFilter = [
    `BBOX(ジオメトリ,${minLng},${minLat},${maxLng},${maxLat},'EPSG:4326')`,
    `時間コード>=${formatTimeCode(startTime)}`,
    `時間コード<=${formatTimeCode(endTime)}`,
  ].join(" AND ");

  const url = new URL(JARTIC_BASE_URL);
  url.searchParams.set("service", "WFS");
  url.searchParams.set("version", "2.0.0");
  url.searchParams.set("request", "GetFeature");
  url.searchParams.set("typeNames", "t_travospublic_measure_5m");
  url.searchParams.set("srsName", "EPSG:4326");
  url.searchParams.set("outputFormat", "application/json");
  url.searchParams.set("exceptions", "application/json");
  url.searchParams.set("cql_filter", cqlFilter);

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.features)) {
      console.error("JARTIC APIからエラー応答:", data);
      return NextResponse.json({ error: "JARTIC APIの取得に失敗しました" }, { status: 502 });
    }

    const features = keepLatestPerPoint(data.features).map(toSimplifiedFeature);
    return NextResponse.json({ type: "FeatureCollection", features });
  } catch (error) {
    console.error("JARTIC交通量データの取得に失敗しました:", error);
    return NextResponse.json({ error: "JARTIC APIへの通信に失敗しました" }, { status: 502 });
  }
}
