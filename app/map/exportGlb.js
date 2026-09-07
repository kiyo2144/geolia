// 3Dマップのエクスポート機能（GLB形式）。
// 要件定義 docs/requirements.md 4.6章に基づき、指定範囲の地形（標高タイル＋
// 背景地図テクスチャ）・森林簿/地籍の押し出しメッシュをthree.jsのシーンとして
// 組み立て、GLBファイルとして書き出す。生成はブラウザ側（クライアント）で行う。

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

const DEM_TILE_ZOOM = 14; // 標高タイルの取得ズーム（GSI標高タイルの提供上限に合わせる）
const BASEMAP_TILE_ZOOM = 17; // 背景地図テクスチャの取得ズーム
const TERRAIN_GRID_SIZE = 64; // 地形メッシュの分割数（1辺あたりの区画数）
const BASEMAP_TEXTURE_SIZE = 1024; // 書き出すテクスチャ画像の一辺のピクセル数
const TILE_PIXEL_SIZE = 256;

function lngLatToTileFloat(lng, lat, z) {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function tileToLngLat(x, y, z) {
  const n = 2 ** z;
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lng, lat: (latRad * 180) / Math.PI };
}

// 緯度経度を、bboxの中心を原点としたメートル単位のローカル座標
// （東=X、北=Y。2D図形の組み立てに使う中間座標であり、3D空間のY-upとは別）に変換する。
function makeProjector(bbox) {
  const lat0 = (bbox.minLat + bbox.maxLat) / 2;
  const lng0 = (bbox.minLng + bbox.maxLng) / 2;
  const lat0Rad = (lat0 * Math.PI) / 180;
  const metersPerDegLng = 111320 * Math.cos(lat0Rad);
  const metersPerDegLat = 110540;
  return (lng, lat) => ({
    x: (lng - lng0) * metersPerDegLng,
    y: (lat - lat0) * metersPerDegLat,
  });
}

// --- 標高データの取得・サンプリング ---

async function fetchDemImageData(z, x, y) {
  const response = await fetch(`/api/dem-tile/${z}/${x}/${y}.png`);
  if (!response.ok) return null;
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

// /api/dem-tile が返すMapbox Terrain-RGB形式のデコード（サーバー側エンコードの逆変換）
function decodeMapboxRgbHeight(r, g, b) {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

async function createElevationSampler(bbox) {
  const z = DEM_TILE_ZOOM;
  const nw = lngLatToTileFloat(bbox.minLng, bbox.maxLat, z);
  const se = lngLatToTileFloat(bbox.maxLng, bbox.minLat, z);
  const minTileX = Math.floor(nw.x);
  const maxTileX = Math.floor(se.x);
  const minTileY = Math.floor(nw.y);
  const maxTileY = Math.floor(se.y);

  const tiles = new Map();
  const tasks = [];
  for (let tx = minTileX; tx <= maxTileX; tx++) {
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      tasks.push(
        fetchDemImageData(z, tx, ty).then((imageData) => {
          if (imageData) tiles.set(`${tx}:${ty}`, imageData);
        }),
      );
    }
  }
  await Promise.all(tasks);

  return (lng, lat) => {
    const { x: xFloat, y: yFloat } = lngLatToTileFloat(lng, lat, z);
    const tx = Math.floor(xFloat);
    const ty = Math.floor(yFloat);
    const imageData = tiles.get(`${tx}:${ty}`);
    if (!imageData) return 0;
    const px = Math.min(imageData.width - 1, Math.floor((xFloat - tx) * imageData.width));
    const py = Math.min(imageData.height - 1, Math.floor((yFloat - ty) * imageData.height));
    const i = (py * imageData.width + px) * 4;
    return decodeMapboxRgbHeight(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]);
  };
}

// --- 背景地図テクスチャの取得・合成 ---

function loadTileImage(basemapKey, z, x, y) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `/api/basemap-tile/${basemapKey}/${z}/${x}/${y}.png`;
  });
}

async function buildBasemapTexture(bbox, basemapKey) {
  const z = BASEMAP_TILE_ZOOM;
  const nw = lngLatToTileFloat(bbox.minLng, bbox.maxLat, z);
  const se = lngLatToTileFloat(bbox.maxLng, bbox.minLat, z);
  const minTileX = Math.floor(nw.x);
  const maxTileX = Math.floor(se.x);
  const minTileY = Math.floor(nw.y);
  const maxTileY = Math.floor(se.y);
  const cols = maxTileX - minTileX + 1;
  const rows = maxTileY - minTileY + 1;

  const mosaicCanvas = document.createElement("canvas");
  mosaicCanvas.width = cols * TILE_PIXEL_SIZE;
  mosaicCanvas.height = rows * TILE_PIXEL_SIZE;
  const mosaicCtx = mosaicCanvas.getContext("2d");

  const tasks = [];
  for (let tx = minTileX; tx <= maxTileX; tx++) {
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      tasks.push(
        loadTileImage(basemapKey, z, tx, ty).then((img) => {
          if (img) {
            mosaicCtx.drawImage(img, (tx - minTileX) * TILE_PIXEL_SIZE, (ty - minTileY) * TILE_PIXEL_SIZE);
          }
        }),
      );
    }
  }
  await Promise.all(tasks);

  // タイルモザイク全体のうち、実際に指定されたbboxに対応する範囲だけを切り出す
  const mosaicNw = tileToLngLat(minTileX, minTileY, z);
  const mosaicSe = tileToLngLat(maxTileX + 1, maxTileY + 1, z);
  const lngSpan = mosaicSe.lng - mosaicNw.lng;
  const latSpan = mosaicSe.lat - mosaicNw.lat; // 負の値（北→南）

  const srcX = ((bbox.minLng - mosaicNw.lng) / lngSpan) * mosaicCanvas.width;
  const srcXEnd = ((bbox.maxLng - mosaicNw.lng) / lngSpan) * mosaicCanvas.width;
  const srcY = ((bbox.maxLat - mosaicNw.lat) / latSpan) * mosaicCanvas.height;
  const srcYEnd = ((bbox.minLat - mosaicNw.lat) / latSpan) * mosaicCanvas.height;

  const canvas = document.createElement("canvas");
  canvas.width = BASEMAP_TEXTURE_SIZE;
  canvas.height = BASEMAP_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    mosaicCanvas,
    srcX,
    srcY,
    srcXEnd - srcX,
    srcYEnd - srcY,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const texture = new THREE.CanvasTexture(canvas);
  // v=0が北（画像上端）に対応するようUVを計算しているため、flipYは無効にする
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// --- 地形メッシュ ---

function buildTerrainMesh(bbox, sampleElevation, project, texture) {
  const size = TERRAIN_GRID_SIZE;
  const stride = size + 1;
  const heights = [];
  let minElevation = Infinity;

  for (let j = 0; j <= size; j++) {
    const lat = bbox.maxLat - (j / size) * (bbox.maxLat - bbox.minLat);
    const row = [];
    for (let i = 0; i <= size; i++) {
      const lng = bbox.minLng + (i / size) * (bbox.maxLng - bbox.minLng);
      const elevation = sampleElevation(lng, lat);
      row.push(elevation);
      if (elevation < minElevation) minElevation = elevation;
    }
    heights.push(row);
  }

  const vertices = [];
  const uvs = [];
  for (let j = 0; j <= size; j++) {
    const lat = bbox.maxLat - (j / size) * (bbox.maxLat - bbox.minLat);
    for (let i = 0; i <= size; i++) {
      const lng = bbox.minLng + (i / size) * (bbox.maxLng - bbox.minLng);
      const { x, y: northMeters } = project(lng, lat);
      const elevation = heights[j][i] - minElevation;
      // 2Dの東西=X・南北=Yを、Y-upの3D空間（東=X, 高さ=Y, 南=Z）に変換する
      vertices.push(x, elevation, -northMeters);
      uvs.push(i / size, j / size);
    }
  }

  const indices = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = texture
    ? new THREE.MeshStandardMaterial({ map: texture })
    : new THREE.MeshStandardMaterial({ color: "#8d6e63" });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  return { mesh, minElevation };
}

// --- 森林簿・地籍の押し出しメッシュ ---

function computeRingCentroid(ring) {
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of ring) {
    sumLng += lng;
    sumLat += lat;
  }
  return { lng: sumLng / ring.length, lat: sumLat / ring.length };
}

function buildParcelGroup(name, features, colorField, project, sampleElevation, minElevation) {
  const group = new THREE.Group();
  group.name = name;

  for (const feature of features) {
    const rings = feature.geometry?.coordinates;
    if (!rings || !rings.length) continue;

    const [exteriorRing, ...holeRings] = rings;
    const toShapePoints = (ring) =>
      ring.map(([lng, lat]) => {
        const { x, y } = project(lng, lat);
        return new THREE.Vector2(x, y);
      });

    const shape = new THREE.Shape(toShapePoints(exteriorRing));
    for (const hole of holeRings) {
      shape.holes.push(new THREE.Path(toShapePoints(hole)));
    }

    const height = Math.max(Number(feature.properties?.height) || 1, 0.1);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    // ExtrudeGeometryはZ方向（法線=手前）に押し出すため、Y-up・南=+Zの座標系に合わせて回転する
    geometry.rotateX(-Math.PI / 2);

    const colorValue = feature.properties?.[colorField];
    const material = new THREE.MeshStandardMaterial({
      color: typeof colorValue === "string" ? colorValue : "#4caf50",
    });

    const mesh = new THREE.Mesh(geometry, material);
    if (sampleElevation) {
      const centroid = computeRingCentroid(exteriorRing);
      mesh.position.y = sampleElevation(centroid.lng, centroid.lat) - minElevation;
    }
    group.add(mesh);
  }

  return group;
}

// --- エクスポート本体 ---

export async function exportMapAsGlb({
  bbox,
  includeTerrain,
  includeParcels,
  includeBasemapTexture,
  basemapKey,
  supabase,
  onProgress,
}) {
  const project = makeProjector(bbox);
  const scene = new THREE.Group();
  scene.name = "geolia_map_export";

  let sampleElevation = null;
  let minElevation = 0;

  if (includeTerrain) {
    onProgress?.("標高データを取得中...");
    sampleElevation = await createElevationSampler(bbox);

    onProgress?.("地形メッシュを生成中...");
    let texture = null;
    if (includeBasemapTexture) {
      onProgress?.("背景地図テクスチャを生成中...");
      texture = await buildBasemapTexture(bbox, basemapKey);
    }
    const { mesh, minElevation: minElev } = buildTerrainMesh(bbox, sampleElevation, project, texture);
    minElevation = minElev;
    scene.add(mesh);
  }

  if (includeParcels) {
    onProgress?.("森林簿・地籍データを取得中...");
    const bboxParam = {
      min_lng: bbox.minLng,
      min_lat: bbox.minLat,
      max_lng: bbox.maxLng,
      max_lat: bbox.maxLat,
    };
    const [{ data: forestData }, { data: landData }] = await Promise.all([
      supabase.rpc("forest_parcels_in_bbox", bboxParam),
      supabase.rpc("land_parcels_in_bbox", bboxParam),
    ]);

    onProgress?.("押し出しメッシュを生成中...");
    if (forestData?.features?.length) {
      scene.add(
        buildParcelGroup(
          "forest_parcels",
          forestData.features,
          "color",
          project,
          sampleElevation,
          minElevation,
        ),
      );
    }
    if (landData?.features?.length) {
      scene.add(
        buildParcelGroup(
          "land_parcels",
          landData.features,
          "color_koaza",
          project,
          sampleElevation,
          minElevation,
        ),
      );
    }
  }

  onProgress?.("GLBファイルを書き出し中...");
  const exporter = new GLTFExporter();
  const arrayBuffer = await new Promise((resolve, reject) => {
    exporter.parse(scene, resolve, reject, { binary: true });
  });
  return arrayBuffer;
}

export function downloadGlb(arrayBuffer, filename) {
  const blob = new Blob([arrayBuffer], { type: "model/gltf-binary" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
