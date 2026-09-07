// サンプル地理データ（森林簿・地籍筆）をSupabaseへ投入する移行スクリプト
// 対応する要件定義: docs/requirements.md 6.5章
//
// 実行方法:
//   node --env-file=.env.local scripts/migrate-sample-geo-data.mjs
//
// 前提:
// - .env.local に NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が設定済みであること
//   （SUPABASE_SERVICE_ROLE_KEY はRLSを回避するための管理者キー。NEXT_PUBLIC_を付けないこと）
// - このスクリプトは camp/geolia の隣にある camp/map フォルダのデータを参照する想定
//   （このプロジェクト固有のローカルなフォルダ配置。異なる配置の場合は下記の SOURCE_DIR を調整すること）
//
// 実行のたびに forest_parcels / land_parcels の中身を全削除してから作り直す（再実行可能）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import proj4 from "proj4";
import * as shapefile from "shapefile";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR =
  process.env.SAMPLE_DATA_DIR ?? path.resolve(__dirname, "../../map");

const FOREST_GEOJSON_PATH = path.join(SOURCE_DIR, "forest_wgs84.geojson");
const LAND_PARCEL_ZIP_PATH = path.join(
  SOURCE_DIR,
  "03402_西磐井郡平泉町_公共座標10系_筆R_2026.shp.zip",
);

const BATCH_SIZE = 500;

// JGD2011 公共座標10系（EPSG:6677相当）。JGD2011はWGS84とほぼ同一とみなして変換する。
const JGD2011_ZONE10 =
  "+proj=tmerc +lat_0=40 +lon_0=140.8333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs";
const toWgs84 = proj4(JGD2011_ZONE10, "WGS84");

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

// ---- 決定的な疑似ランダム値の生成（同じキーなら常に同じ値になる。4.4.4章の方針） ----

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function hashToRange(key, min, max) {
  const h = hashString(key);
  return min + ((h % 10000) / 10000) * (max - min);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function hashToColor(key) {
  const h = hashString(key);
  return hslToHex(h % 360, 55, 55);
}

// ---- ジオメトリ変換 ----

function ringToWkt(ring, project) {
  const points = ring.map(([x, y]) => {
    const [lng, lat] = project ? project([x, y]) : [x, y];
    return `${lng} ${lat}`;
  });
  return `(${points.join(",")})`;
}

function polygonToEwkt(coordinates, project) {
  const rings = coordinates.map((ring) => ringToWkt(ring, project));
  return `SRID=4326;POLYGON(${rings.join(",")})`;
}

// ---- テーブルの全件削除（再実行可能にするため） ----

async function truncateTable(table) {
  const { error } = await supabase.from(table).delete().not("id", "is", null);
  if (error) throw new Error(`${table} の削除に失敗: ${error.message}`);
}

async function insertInBatches(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(batch);
    if (error) {
      throw new Error(
        `${table} へのinsertに失敗（${i}件目〜）: ${error.message}`,
      );
    }
    console.log(
      `  ${table}: ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length} 件投入済み`,
    );
  }
}

// ---- 森林簿 ----

async function migrateForestParcels() {
  console.log("森林簿データを読み込み中...");
  const geojson = JSON.parse(fs.readFileSync(FOREST_GEOJSON_PATH, "utf8"));

  const rows = geojson.features.map((feature) => {
    const { rinhan, shohan, sehyoban, height, color } = feature.properties;
    return {
      rinhan,
      shohan,
      sehyoban,
      height,
      color,
      geom: polygonToEwkt(feature.geometry.coordinates, null),
    };
  });

  console.log(`森林簿: ${rows.length}件を投入します`);
  await truncateTable("forest_parcels");
  await insertInBatches("forest_parcels", rows);
}

// ---- 地籍筆 ----

async function extractShapefile(zipPath) {
  const zip = new AdmZip(zipPath);
  const outDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "geolia-land-parcels-"),
  );
  zip.extractAllTo(outDir, true);

  const shpEntry = zip
    .getEntries()
    .find((entry) => entry.entryName.toLowerCase().endsWith(".shp"));
  const baseName = shpEntry.entryName.replace(/\.shp$/i, "");
  return { base: path.join(outDir, baseName), outDir };
}

async function migrateLandParcels() {
  console.log("地籍筆データ（シェープファイル）を展開中...");
  const { base, outDir } = await extractShapefile(LAND_PARCEL_ZIP_PATH);

  try {
    const source = await shapefile.open(`${base}.shp`, `${base}.dbf`, {
      encoding: "shift-jis",
    });

    const rows = [];
    let result;
    while (!(result = await source.read()).done) {
      const { properties, geometry } = result.value;
      const id = properties["ID"];
      const koazaName = properties["小字名"] ?? "";
      const precisionClass = properties["精度区分"] ?? "";

      rows.push({
        source_id: id,
        city_code: properties["市区町村C"],
        oaza_code: properties["大字コード"],
        chome_code: properties["丁目コード"],
        koaza_code: properties["小字コード"],
        city_name: properties["市区町村名"],
        oaza_name: properties["大字名"],
        koaza_name: koazaName,
        chiban: properties["地番"],
        precision_class: precisionClass,
        coordinate_type: properties["座標値種別"],
        map_name: properties["地図名"],
        coordinate_system: properties["座標系"],
        datum_type: properties["測地系判別"],
        height: hashToRange(id, 3, 15),
        color_koaza: hashToColor(koazaName),
        color_seido: hashToColor(precisionClass),
        geom: polygonToEwkt(geometry.coordinates, (p) => toWgs84.forward(p)),
      });
    }

    console.log(`地籍筆: ${rows.length}件を投入します`);
    await truncateTable("land_parcels");
    await insertInBatches("land_parcels", rows);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function main() {
  await migrateForestParcels();
  await migrateLandParcels();
  console.log("完了しました。");
}

main().catch((error) => {
  console.error("移行に失敗しました:", error);
  process.exit(1);
});
