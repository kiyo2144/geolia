// OpenStreetMapの建物データ（Overpass API）を取得し、osm_buildingsテーブルへ投入する移行スクリプト
// 対応: 「オープンストリートマップの建物データを3Dマップに反映する」機能
//
// 実行方法:
//   node --env-file=.env.local scripts/migrate-osm-buildings.mjs
//
// 前提:
// - .env.local に NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が設定済みであること
// - supabase/migrations/20260907200000_osm_buildings.sql が適用済みであること
//
// 取得範囲は /map画面のパン可能範囲（HIRAIZUMI_MAX_BOUNDS、app/map/MapView.js）に合わせる。
// 実行のたびにosm_buildingsの中身を全削除してから作り直す（再実行可能）。

import { createClient } from "@supabase/supabase-js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// app/map/MapView.js の HIRAIZUMI_MAX_BOUNDS と同じ範囲（南西・北東）
const BBOX = { south: 38.92, west: 140.95, north: 39.06, east: 141.25 };

const BATCH_SIZE = 500;
const DEFAULT_HEIGHT_METERS = 6; // 高さタグが無い場合の推定値（2階建て相当）
const METERS_PER_LEVEL = 3;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

async function fetchOverpassBuildings() {
  const query = `[out:json][timeout:180];(way["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}););out geom;`;
  console.log("Overpass APIから建物データを取得中...（数分かかることがあります）");

  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
      "User-Agent": "geolia-osm-buildings-migration/1.0",
    },
    body: new URLSearchParams({ data: query }),
  });
  if (!response.ok) {
    throw new Error(`Overpass APIエラー: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.elements;
}

// 高さタグ(m)・building:levelsタグ・デフォルト値の優先順で高さを決定する
// （要件定義4.4.4章「高さ算出方法の統一方針」と同様、実測値が無い場合は推定値を用いる）
function resolveHeight(tags) {
  const heightTag = tags.height ?? tags["est_height"];
  if (heightTag) {
    const parsed = parseFloat(heightTag);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { height: parsed, heightSource: "tag" };
    }
  }

  const levelsTag = tags["building:levels"];
  if (levelsTag) {
    const levels = parseFloat(levelsTag);
    if (Number.isFinite(levels) && levels > 0) {
      return { height: levels * METERS_PER_LEVEL, heightSource: "levels" };
    }
  }

  return { height: DEFAULT_HEIGHT_METERS, heightSource: "default" };
}

// GeoJSON/RFC 7946は反時計回りの外周を要求するが、ここでは向きを気にせず格納し、
// 表示側（osm_buildings_in_bbox RPC）でST_ForcePolygonCCWにより補正する
// （森林簿・地籍データで実際に踏んだ不具合と同じ対策）。
function wayToPolygonEwkt(way) {
  const points = way.geometry;
  if (!points || points.length < 4) return null;

  const coords = points.map((p) => `${p.lon} ${p.lat}`);
  const first = points[0];
  const last = points[points.length - 1];
  if (first.lat !== last.lat || first.lon !== last.lon) {
    coords.push(`${first.lon} ${first.lat}`);
  }

  return `SRID=4326;POLYGON((${coords.join(",")}))`;
}

async function truncateTable(table) {
  const { error } = await supabase.from(table).delete().not("id", "is", null);
  if (error) throw new Error(`${table} の削除に失敗: ${error.message}`);
}

async function insertInBatches(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(batch);
    if (error) {
      throw new Error(`${table} へのinsertに失敗（${i}件目〜）: ${error.message}`);
    }
    console.log(`  ${table}: ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length} 件投入済み`);
  }
}

async function main() {
  const elements = await fetchOverpassBuildings();
  console.log(`取得件数: ${elements.length}件`);

  const rows = [];
  for (const way of elements) {
    const geom = wayToPolygonEwkt(way);
    if (!geom) continue;

    const tags = way.tags ?? {};
    const { height, heightSource } = resolveHeight(tags);

    rows.push({
      osm_id: way.id,
      name: tags.name ?? null,
      building_type: tags.building ?? null,
      height,
      height_source: heightSource,
      geom,
    });
  }

  console.log(`OSM建物: ${rows.length}件を投入します（ジオメトリ不正のためスキップ: ${elements.length - rows.length}件）`);
  await truncateTable("osm_buildings");
  await insertInBatches("osm_buildings", rows);
  console.log("完了しました。");
}

main().catch((error) => {
  console.error("移行に失敗しました:", error);
  process.exit(1);
});
