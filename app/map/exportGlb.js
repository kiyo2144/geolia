// 3Dマップのエクスポート機能（GLB形式）。
// 要件定義 docs/requirements.md 4.6章に基づき、指定範囲の地形（標高タイル＋
// 背景地図テクスチャ）・森林簿/地籍の押し出しメッシュをthree.jsのシーンとして
// 組み立て、GLBファイルとして書き出す。生成はブラウザ側（クライアント）で行う。

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  BUILDING_COLOR,
  NAMED_BUILDING_COLOR,
  buildBasemapTexture,
  buildParcelGroup,
  buildTerrainMesh,
  createElevationSampler,
  makeProjector,
} from "./mapMeshBuilders";

// --- エクスポート本体 ---

export async function exportMapAsGlb({
  bbox,
  includeTerrain,
  includeParcels,
  includeBuildings,
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

  if (includeBuildings) {
    onProgress?.("OSM建物データを取得中...");
    const bboxParam = {
      min_lng: bbox.minLng,
      min_lat: bbox.minLat,
      max_lng: bbox.maxLng,
      max_lat: bbox.maxLat,
    };
    const { data: buildingsData } = await supabase.rpc("osm_buildings_in_bbox", bboxParam);

    onProgress?.("建物メッシュを生成中...");
    if (buildingsData?.features?.length) {
      // /map画面と同じ色分け（名称のある建物＝注目スポットは別色）をエクスポートにも反映する
      for (const feature of buildingsData.features) {
        feature.properties.color = feature.properties.name
          ? NAMED_BUILDING_COLOR
          : BUILDING_COLOR;
      }
      scene.add(
        buildParcelGroup(
          "osm_buildings",
          buildingsData.features,
          "color",
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
