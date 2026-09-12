"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createClient } from "@/lib/supabase/client";
import { FirstPersonView } from "./FirstPersonView";
import { createElevationSampler } from "./mapMeshBuilders";
import { ArPlacementPopupContent } from "./ArPlacementPopupContent";
import { fetchNearbyRoadWays, findNearestWay } from "./roadSegmentMatch";
import styles from "./MapView.module.css";

// v6は最新すぎてバンドラー環境でのWorker解決やfill-extrusion描画に問題があったため、
// map_overlay.html（既存プロトタイプ）でも実績のあるv4.7.1系を使用する。
const { Map: MapLibreMap, NavigationControl, ScaleControl, Popup, Marker } = maplibregl;

const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>';

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

// 背景地図の選択肢。地形表現（標高タイル）はこれとは独立した別レイヤーなので、
// どの背景地図を選んでも同じように重ねて表示できる。
const BASEMAP_TILES = {
  pale: {
    label: "地理院 淡色地図",
    urls: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
    maxzoom: 18,
    attribution: GSI_ATTRIBUTION,
  },
  std: {
    label: "地理院 標準地図",
    urls: ["https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"],
    maxzoom: 18,
    attribution: GSI_ATTRIBUTION,
  },
  photo: {
    label: "地理院 写真",
    urls: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
    maxzoom: 18,
    attribution: GSI_ATTRIBUTION,
  },
  osm: {
    label: "OpenStreetMap",
    urls: [
      "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
    ],
    maxzoom: 19,
    attribution: OSM_ATTRIBUTION,
  },
};

// 国土地理院の標高タイルはCORSヘッダーを返さずブラウザから直接fetchできないため、
// 同一オリジンのAPIルート（app/api/dem-tile）でMapbox Terrain-RGB形式に変換して配信する。
const DEM_TILE_URL = "/api/dem-tile/{z}/{x}/{y}.png";

const MIN_ZOOM_FOR_DATA = 13;

// 起動時、現在地が取得できればその地点を中心にズームレベルこの値・上面（真上から
// 見下ろす）表示にする。取得できない場合は町全体を見渡せる俯瞰表示にフォールバックする。
const CURRENT_LOCATION_INITIAL_ZOOM = 17;
const GEOLOCATION_INITIAL_TIMEOUT_MS = 4000;

// 通常は右ドラッグ／Ctrl+ドラッグで地図の回転・傾きを操作するが、スクロールボタン
// （ホイールクリック）を押しながらのドラッグでも同様に操作できるようにするための感度。
const MIDDLE_BUTTON_ROTATE_SENSITIVITY = 0.3; // 1pxあたりの回転角度（度）
const MIDDLE_BUTTON_PITCH_SENSITIVITY = 0.3; // 1pxあたりの傾き角度（度）

// スマートフォンでの2本指ドラッグによる傾き操作は、2本指を縦に並べた状態だと
// 正しく認識されないことがある（maplibre-glの内部的なジェスチャー判定の制約と見られ、
// 外部から調整できる設定項目はない）。ジェスチャー操作自体はそのまま維持しつつ、
// 指の向きに関係なく確実に傾きを調整できるボタンを地図上に追加する。
const PITCH_BUTTON_STEP_DEG = 5; // 1回の押下・1ティックあたりの傾き変化量
const PITCH_BUTTON_REPEAT_MS = 80; // 押し続けたときの変化間隔

/** 地図の傾きをボタンで調整するためのmaplibre-glカスタムコントロール */
class PitchControl {
  onAdd(map) {
    this._map = map;
    this._intervalId = null;

    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";

    const makeButton = (label, ariaLabel, deltaDeg) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", ariaLabel);
      button.title = ariaLabel;
      button.textContent = label;

      const tick = () => {
        const next = Math.min(Math.max(map.getPitch() + deltaDeg, 0), map.getMaxPitch());
        map.setPitch(next);
      };
      const start = (event) => {
        event.preventDefault();
        this._stopRepeat();
        tick();
        this._intervalId = setInterval(tick, PITCH_BUTTON_REPEAT_MS);
      };
      const stop = () => this._stopRepeat();

      button.addEventListener("pointerdown", start);
      button.addEventListener("pointerup", stop);
      button.addEventListener("pointerleave", stop);
      button.addEventListener("pointercancel", stop);
      return button;
    };

    container.appendChild(makeButton("⇗", "傾きを増やす", PITCH_BUTTON_STEP_DEG));
    container.appendChild(makeButton("⇘", "傾きを減らす", -PITCH_BUTTON_STEP_DEG));

    this._container = container;
    return container;
  }

  _stopRepeat() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  onRemove() {
    this._stopRepeat();
    this._container.remove();
    this._map = undefined;
  }
}

/**
 * 地図上のカーソル位置の緯度・経度・標高を表示するmaplibre-glカスタムコントロール。
 * mousemoveのたびにReactの再レンダーを起こさないよう、DOM要素を直接更新する。
 */
class CursorInfoControl {
  onAdd() {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl";
    Object.assign(container.style, {
      padding: "4px 8px",
      background: "rgba(255, 255, 255, 0.85)",
      borderRadius: "4px",
      fontSize: "11px",
      lineHeight: "1.6",
      color: "#1a1a1a",
      fontFamily: "monospace",
      whiteSpace: "nowrap",
      display: "none",
    });
    this._container = container;
    return container;
  }

  update(lng, lat, elevation) {
    this._container.style.display = "block";
    const elevationLabel =
      elevation === null || elevation === undefined ? "-" : `約${elevation.toFixed(1)}m`;
    this._container.textContent = `緯度 ${lat.toFixed(6)} / 経度 ${lng.toFixed(6)} / 標高 ${elevationLabel}`;
  }

  clear() {
    this._container.style.display = "none";
  }

  onRemove() {
    this._container.remove();
  }
}

// 平泉町の森林簿・地籍データの実際の範囲（南西・北東の緯度経度）。
// forest_parcels / land_parcels 全件のジオメトリから算出した実測値。
const HIRAIZUMI_DATA_BOUNDS = [
  [141.0063447050003, 38.949578826], // 南西
  [141.1919757, 39.028813277000005], // 北東
];

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };

// 現在地マーカーのピン色。地図の傾き・向きに関わらず常に同じ見た目になるよう、
// 3D立体物（fill-extrusion）ではなくDOM要素のアイコン（常にカメラ正面を向く）で表示する。
const LOCATION_MARKER_COLOR = "#e63946";

// AR配置ピンの色。現在地マーカーと区別できるよう別の色にする。
const AR_PLACEMENT_MARKER_COLOR = "#8e44ad";

// 一人称視点の開始地点ピンの色。
const FIRST_PERSON_MARKER_COLOR = "#2b6cff";

// 一人称視点の開始地点ピン用のシンプルなSVGマーカー要素を作る。
// createPinMarkerElement()とは違い、maplibregl.Markerに直接渡して位置管理を
// 任せる（地形の起伏を考慮した独自の投影計算をする現在地・AR配置ピンとは異なり、
// クリックした地点そのものを示すだけなので、それで十分なため）。
function createFirstPersonPinElement(color) {
  const el = document.createElement("div");
  el.innerHTML =
    '<svg viewBox="0 0 28 28" width="28" height="28" xmlns="http://www.w3.org/2000/svg">' +
    `<path d="M14 1c-6.075 0-11 4.925-11 11 0 8.25 11 15 11 15s11-6.75 11-15c0-6.075-4.925-11-11-11z" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>` +
    '<circle cx="14" cy="12" r="4.2" fill="#ffffff"/>' +
    "</svg>";
  return el;
}

// OSM建物データの色（実測の高さが無いものが大半のため、単色の落ち着いた色にする）。
// 「建物」という汎用名ではなく固有の名称（OSMのnameタグ）が付いているものは
// 重要なスポットとみなし、目立つ色で区別する。
const BUILDING_COLOR = "#c9b8a3";
const NAMED_BUILDING_COLOR = "#e0a526";

// 【実験的機能】JARTIC観測点と道路線の対応づけで、これより離れていたら
// 対応する道路が無いとみなす（誤って無関係な道路をハイライトしないための閾値）
const ROAD_MATCH_MAX_DISTANCE_METERS = 80;

// JARTIC道路交通量（上り+下り合計台数/5分）の色分け。点・道路ハイライトの両レイヤーで共用する。
const TRAFFIC_COLOR_EXPRESSION = [
  "interpolate",
  ["linear"],
  ["+", ["get", "upTotal"], ["get", "downTotal"]],
  0,
  "#4caf50",
  100,
  "#ffc107",
  250,
  "#f44336",
];

function baseStyle(kind) {
  const tile = BASEMAP_TILES[kind];
  return {
    version: 8,
    sources: {
      "gsi-base": {
        type: "raster",
        tiles: tile.urls,
        tileSize: 256,
        maxzoom: tile.maxzoom,
        attribution: tile.attribution,
      },
    },
    layers: [{ id: "gsi-base-layer", type: "raster", source: "gsi-base" }],
  };
}

// 森林簿・地籍筆は、再取得のたびに一瞬データが消えて見えることのないよう、
// 「二重バッファ」方式で表示する。同じデータについてソース・レイヤーを a/b の
// 2系統用意しておき、新しいデータは非表示側(inactive)に読み込んでおいて、
// 描画の準備ができてから表示を瞬時に入れ替える（表示側は常にどちらか一方のみ）。
const BUFFER_LAYER_CONFIG = {
  forest: {
    colorExpr: () => ["get", "color"],
  },
  land: {
    colorExpr: (landColorMode) => [
      "get",
      landColorMode === "koaza" ? "color_koaza" : "color_seido",
    ],
  },
  buildings: {
    colorExpr: () => [
      "case",
      ["!=", ["get", "name"], null],
      NAMED_BUILDING_COLOR,
      BUILDING_COLOR,
    ],
  },
};

function addDataLayers(map, landColorMode) {
  for (const key of Object.keys(BUFFER_LAYER_CONFIG)) {
    for (const buffer of ["a", "b"]) {
      const sourceId = `${key}-${buffer}`;
      const layerId = `${key}-fill-${buffer}`;
      if (map.getSource(sourceId)) continue;

      map.addSource(sourceId, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
      map.addLayer({
        id: layerId,
        type: "fill-extrusion",
        source: sourceId,
        layout: { visibility: buffer === "a" ? "visible" : "none" },
        paint: {
          "fill-extrusion-color": BUFFER_LAYER_CONFIG[key].colorExpr(landColorMode),
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-opacity": 0.85,
        },
      });
    }
  }
}

// 標高タイルによる地形起伏（試験的機能）の有効/無効・強調倍率を切り替える。
// スタイル読み込み未完了時はエラーになるため、呼び出し側でtry/catchするか、
// スタイル読み込み確認後（isStyleLoaded()）に呼び出すこと。
function applyTerrain(map, enabled, exaggeration) {
  if (enabled) {
    if (!map.getSource("terrain-dem")) {
      map.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: [DEM_TILE_URL],
        tileSize: 256,
        minzoom: 12,
        maxzoom: 14,
        attribution: GSI_ATTRIBUTION,
      });
    }
    map.setTerrain({ source: "terrain-dem", exaggeration });
  } else {
    map.setTerrain(null);
  }
}

// 起動時の初期カメラ位置を、現在地が取得できればその地点中心・上面表示で、
// 取得できなければ（拒否・タイムアウト等）nullを返す（呼び出し側で町全体の俯瞰表示にフォールバックする）。
function getInitialCameraFromLocation() {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (camera) => {
      if (settled) return;
      settled = true;
      resolve(camera);
    };
    const timeoutId = setTimeout(() => finish(null), GEOLOCATION_INITIAL_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timeoutId);
        finish({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: CURRENT_LOCATION_INITIAL_ZOOM,
          pitch: 0,
          bearing: 0,
        });
      },
      () => {
        clearTimeout(timeoutId);
        finish(null);
      },
      { enableHighAccuracy: true, timeout: GEOLOCATION_INITIAL_TIMEOUT_MS, maximumAge: 60000 },
    );
  });
}

const FALLBACK_INITIAL_CAMERA = {
  bounds: HIRAIZUMI_DATA_BOUNDS,
  fitBoundsOptions: { padding: 40 },
  pitch: 50,
  bearing: -10,
};

// 非表示側のバッファに新データを流し込み、描画の準備ができてから表示を入れ替える。
function swapBufferData(map, key, bufferRef, data) {
  const activeBuffer = bufferRef.current;
  const nextBuffer = activeBuffer === "a" ? "b" : "a";
  const nextSourceId = `${key}-${nextBuffer}`;
  const nextLayerId = `${key}-fill-${nextBuffer}`;
  const activeLayerId = `${key}-fill-${activeBuffer}`;

  map.getSource(nextSourceId).setData(data);
  map.once("idle", () => {
    if (!map.getLayer(nextLayerId)) return;
    map.setLayoutProperty(nextLayerId, "visibility", "visible");
    map.setLayoutProperty(activeLayerId, "visibility", "none");
    bufferRef.current = nextBuffer;
  });
}

// JARTIC交通量APIの時間コード（例: 202609121745）を読みやすい表記に変換する
function formatJarticTimeCode(timeCode) {
  const s = String(timeCode);
  return `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

function clearBufferData(map, key, bufferRef) {
  const activeBuffer = bufferRef.current;
  map.getSource(`${key}-${activeBuffer}`)?.setData(EMPTY_FEATURE_COLLECTION);
  const otherBuffer = activeBuffer === "a" ? "b" : "a";
  map.getSource(`${key}-${otherBuffer}`)?.setData(EMPTY_FEATURE_COLLECTION);
}

// ピン型アイコンのDOM要素を作成する。現在地マーカー・AR配置ピンで共用する。
// マーカーはこの要素をmaplibre-glのレイヤーではなく地図のキャンバスコンテナに直接重ねて
// 表示するため、地図を回転・傾けても常にカメラ正面を向いた同じ見た目になる。
function createPinMarkerElement(color) {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.top = "0";
  el.style.left = "0";
  el.style.width = "28px";
  el.style.height = "28px";
  el.style.marginLeft = "-14px";
  el.style.marginTop = "-28px";
  el.style.pointerEvents = "auto";
  el.style.cursor = "pointer";
  el.style.display = "none";
  el.innerHTML =
    '<svg viewBox="0 0 28 28" width="28" height="28" xmlns="http://www.w3.org/2000/svg">' +
    `<path d="M14 1c-6.075 0-11 4.925-11 11 0 8.25 11 15 11 15s11-6.75 11-15c0-6.075-4.925-11-11-11z" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>` +
    '<circle cx="14" cy="12" r="4.2" fill="#ffffff"/>' +
    "</svg>";
  return el;
}

// (lng, lat, 高度[m]) の3次元位置を、地図の現在の傾き・回転・ズームに応じた
// スクリーン座標（キャンバスコンテナ内のピクセル位置）に変換する。
// maplibre-glは地形（terrain）の標高をこの仕組みで画面に投影しているため、
// それを流用し、地形の標高の代わりに任意の高度を渡すことで実現している。
function projectAtElevation(map, lng, lat, elevationMeters) {
  const elevationSource = { getElevationForLngLatZoom: () => elevationMeters };
  return map.transform.locationPoint({ lng, lat }, elevationSource);
}

const SVG_NS = "http://www.w3.org/2000/svg";

// 地形（標高タイル）上の地点を示す小さな点と、そこからマーカー（現在地・AR配置）の
// 先端までを結ぶ線。高度によって空中に浮いて見えるマーカーが、地形上のどの位置の
// 真上にあるのかを分かりやすくするために使う（高度が無い＝地表面のマーカーには不要）。
function createGroundLineElements(svgRoot, color) {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", "4 3");
  line.style.display = "none";

  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", "4");
  dot.setAttribute("fill", color);
  dot.setAttribute("stroke", "#ffffff");
  dot.setAttribute("stroke-width", "1.5");
  dot.style.display = "none";
  dot.style.pointerEvents = "none";

  // 点自体（半径4px）はタップ・クリックの的として小さすぎるため、見た目には出ない
  // 少し大きめの当たり判定用の円を重ねる。
  const hitArea = document.createElementNS(SVG_NS, "circle");
  hitArea.setAttribute("r", "12");
  hitArea.setAttribute("fill", "transparent");
  hitArea.style.display = "none";
  hitArea.style.pointerEvents = "none";
  hitArea.style.cursor = "pointer";

  svgRoot.appendChild(line);
  svgRoot.appendChild(dot);
  svgRoot.appendChild(hitArea);
  return { line, dot, hitArea };
}

function updateGroundLine(elements, groundPoint, tipPoint) {
  const { line, dot, hitArea } = elements;
  if (!groundPoint) {
    line.style.display = "none";
    dot.style.display = "none";
    hitArea.style.display = "none";
    hitArea.style.pointerEvents = "none";
    return;
  }
  line.style.display = "";
  dot.style.display = "";
  hitArea.style.display = "";
  hitArea.style.pointerEvents = "auto";
  line.setAttribute("x1", groundPoint.x);
  line.setAttribute("y1", groundPoint.y);
  line.setAttribute("x2", tipPoint.x);
  line.setAttribute("y2", tipPoint.y);
  dot.setAttribute("cx", groundPoint.x);
  dot.setAttribute("cy", groundPoint.y);
  hitArea.setAttribute("cx", groundPoint.x);
  hitArea.setAttribute("cy", groundPoint.y);
}

function removeGroundLine(elements) {
  elements.line.remove();
  elements.dot.remove();
  elements.hitArea.remove();
}

export default function MapView() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const skipNextBasemapChangeRef = useRef(true);
  const supabase = useMemo(() => createClient(), []);

  const [basemap, setBasemap] = useState("osm");
  const [forestVisible, setForestVisible] = useState(true);
  const [landVisible, setLandVisible] = useState(false);
  const [buildingsVisible, setBuildingsVisible] = useState(true);
  const [trafficVisible, setTrafficVisible] = useState(false);
  const [landColorMode, setLandColorMode] = useState("koaza");
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [terrainExaggeration, setTerrainExaggeration] = useState(1.5);
  const [status, setStatus] = useState("");
  // スマートフォン等の狭い画面ではサイドメニューが地図を覆ってしまうため、
  // 初期状態は画面幅に応じて開閉を決める（デスクトップ幅では常に開いた状態にする）。
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 768,
  );
  // タッチ操作の端末では、地図操作の説明文をタッチジェスチャー向けの内容に切り替える
  const [isTouchDevice] = useState(() =>
    typeof window === "undefined" ? false : "ontouchstart" in window || navigator.maxTouchPoints > 0,
  );
  const [locationStatus, setLocationStatus] = useState("");
  const locationWatchIdRef = useRef(null);
  const locationMarkerElRef = useRef(null);
  const locationPositionRef = useRef(null);
  const updateLocationMarkerRef = useRef(() => {});
  // 現在地・AR配置ピンについて、高度がある場合に地形上の地点から先端まで線を引くための
  // SVGオーバーレイ（キャンバスコンテナに重ねて表示する。地図のレイヤーではないので
  // ズーム・回転・傾きに合わせて自前で座標を更新する必要がある）。
  const groundLinesSvgRef = useRef(null);
  // 現在地・AR配置ピンの地表面の高さ算出には、map.queryTerrainElevation()ではなく
  // これ（一人称視点・GLBエクスポートと同じ、標高タイルを直接取得・デコードする
  // 独自実装）を使う。実機検証の結果、map.queryTerrainElevation()は環境によって
  // 標高タイルの実際の値と大きく異なる値を返すことがあり、地図を傾けた際に
  // マーカーの位置が地形とずれて見える不具合の原因になっていたため。
  const elevationSamplerRef = useRef(() => 0);
  // カーソル位置の緯度経度・標高を表示するコントロール（mousemoveで直接更新する）
  const cursorInfoControlRef = useRef(null);

  const [arPlacementsVisible, setArPlacementsVisible] = useState(true);
  const arPlacementsVisibleRef = useRef(arPlacementsVisible);
  useEffect(() => {
    arPlacementsVisibleRef.current = arPlacementsVisible;
  }, [arPlacementsVisible]);
  // key: ar_placements.id, value: { el, lng, lat, altitude, properties }
  const arPlacementMarkersRef = useRef(new Map());
  const updateArPlacementMarkersRef = useRef(() => {});
  const arPlacementPopupRef = useRef(null);
  // AR配置ポップアップの中身はMapLibreの生HTMLではなくReactコンポーネント
  // （ArPlacementPopupContent、3Dプレビュー・削除ボタンを含む）で描画するため、
  // setDOMContentで使う入れ物のdivをstateの遅延初期化で一度だけ作って保持し、
  // 選択中の配置をReact側のポータルで描画する（マウント時に一度作るだけなので、
  // 副作用として扱う必要はない＝Effect内でのsetState呼び出しを避けられる）。
  const [arPlacementPopupContainer] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const [selectedArPlacement, setSelectedArPlacement] = useState(null);
  // 高度接続線の地表面側の点をクリックしたときに、その地点の標高タイルの高度を表示する
  const terrainElevationPopupRef = useRef(null);

  const [exportRangeMode, setExportRangeMode] = useState("current");
  const [exportBbox, setExportBbox] = useState(null);
  const [isSelectingRectangle, setIsSelectingRectangle] = useState(false);
  const [exportIncludeTerrain, setExportIncludeTerrain] = useState(true);
  const [exportIncludeParcels, setExportIncludeParcels] = useState(true);
  const [exportIncludeBuildings, setExportIncludeBuildings] = useState(false);
  const [exportIncludeBasemapTexture, setExportIncludeBasemapTexture] = useState(true);
  const [exportStatus, setExportStatus] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const selectionModeRef = useRef(isSelectingRectangle);
  useEffect(() => {
    selectionModeRef.current = isSelectingRectangle;
  }, [isSelectingRectangle]);

  // 一人称視点で確認する機能。森林簿・地籍・建物のいずれも無い場所を地図上で
  // クリックすると、その地点にピンを立てる（まだ起動はしない）。ピンが立った状態で
  // 「一人称視点で確認」ボタン（地図上のポップアップ）を押すと、その地点を起点に
  // 一人称ビュー（FirstPersonView）を起動する。
  const [firstPersonPendingOrigin, setFirstPersonPendingOrigin] = useState(null);
  const firstPersonMarkerRef = useRef(null);
  const [firstPersonOrigin, setFirstPersonOrigin] = useState(null);

  // ピンが立っている間、地図上に「一人称視点で確認」「キャンセル」ボタン付きの
  // ポップアップを表示する。closeButtonは使わず（マーカー削除時にもcloseイベントが
  // 発火し、Reactの状態更新と競合するため）、ボタンで明示的にキャンセルさせる。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !firstPersonPendingOrigin) {
      firstPersonMarkerRef.current?.remove();
      firstPersonMarkerRef.current = null;
      return undefined;
    }

    const popupContent = document.createElement("div");
    popupContent.className = styles.firstPersonPopup;
    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.textContent = "一人称視点で確認";
    confirmButton.addEventListener("click", () => {
      setFirstPersonOrigin(firstPersonPendingOrigin);
      setFirstPersonPendingOrigin(null);
    });
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "キャンセル";
    cancelButton.addEventListener("click", () => {
      setFirstPersonPendingOrigin(null);
    });
    popupContent.appendChild(confirmButton);
    popupContent.appendChild(cancelButton);

    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 20 }).setDOMContent(
      popupContent,
    );
    const marker = new Marker({
      element: createFirstPersonPinElement(FIRST_PERSON_MARKER_COLOR),
      anchor: "bottom",
    })
      .setLngLat([firstPersonPendingOrigin.lng, firstPersonPendingOrigin.lat])
      .setPopup(popup)
      .addTo(map);
    marker.togglePopup();
    firstPersonMarkerRef.current = marker;

    return () => {
      marker.remove();
    };
  }, [firstPersonPendingOrigin]);

  const latestFlagsRef = useRef({ forestVisible, landVisible, buildingsVisible, trafficVisible });
  useEffect(() => {
    latestFlagsRef.current = { forestVisible, landVisible, buildingsVisible, trafficVisible };
  }, [forestVisible, landVisible, buildingsVisible, trafficVisible]);

  const terrainEnabledRef = useRef(terrainEnabled);
  useEffect(() => {
    terrainEnabledRef.current = terrainEnabled;
  }, [terrainEnabled]);

  const terrainExaggerationRef = useRef(terrainExaggeration);
  useEffect(() => {
    terrainExaggerationRef.current = terrainExaggeration;
  }, [terrainExaggeration]);

  // 現在どちらのバッファ(a/b)が表示側になっているかを記録する
  const forestBufferRef = useRef("a");
  const landBufferRef = useRef("a");
  const buildingsBufferRef = useRef("a");

  const refreshData = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !map.getSource("forest-a") || !map.getSource("land-a")) return;

    if (map.getZoom() < MIN_ZOOM_FOR_DATA) {
      clearBufferData(map, "forest", forestBufferRef);
      clearBufferData(map, "land", landBufferRef);
      setStatus("ズームレベルを上げると詳細データが表示されます");
      return;
    }

    const bounds = map.getBounds();
    const bbox = {
      min_lng: bounds.getWest(),
      min_lat: bounds.getSouth(),
      max_lng: bounds.getEast(),
      max_lat: bounds.getNorth(),
    };
    const {
      forestVisible: showForest,
      landVisible: showLand,
      buildingsVisible: showBuildings,
    } = latestFlagsRef.current;

    setStatus("読み込み中...");

    const tasks = [];
    if (showForest) {
      tasks.push(
        supabase.rpc("forest_parcels_in_bbox", bbox).then(({ data, error }) => {
          if (!error && data) swapBufferData(map, "forest", forestBufferRef, data);
        }),
      );
    } else {
      clearBufferData(map, "forest", forestBufferRef);
    }
    if (showLand) {
      tasks.push(
        supabase.rpc("land_parcels_in_bbox", bbox).then(({ data, error }) => {
          if (!error && data) swapBufferData(map, "land", landBufferRef, data);
        }),
      );
    } else {
      clearBufferData(map, "land", landBufferRef);
    }
    if (showBuildings) {
      tasks.push(
        supabase.rpc("osm_buildings_in_bbox", bbox).then(({ data, error }) => {
          if (!error && data) swapBufferData(map, "buildings", buildingsBufferRef, data);
        }),
      );
    } else {
      clearBufferData(map, "buildings", buildingsBufferRef);
    }
    await Promise.all(tasks);
    setStatus("");
  }, [supabase]);

  // JARTIC（道路交通情報センター）の交通量データ。外部APIかつ更新頻度が5分単位のため、
  // 森林簿・地籍等とは別の軽量な単一ソース（バッファ切り替えなし）で扱う。
  const refreshTraffic = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !map.getSource("traffic-points")) return;

    if (!latestFlagsRef.current.trafficVisible) {
      map.getSource("traffic-points").setData(EMPTY_FEATURE_COLLECTION);
      map.getSource("traffic-road-highlight")?.setData(EMPTY_FEATURE_COLLECTION);
      return;
    }

    const bounds = map.getBounds();
    const bbox = {
      minLng: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLng: bounds.getEast(),
      maxLat: bounds.getNorth(),
    };
    const params = new URLSearchParams(bbox);
    let trafficData = null;
    try {
      const res = await fetch(`/api/jartic-traffic?${params}`);
      trafficData = await res.json();
      if (res.ok) {
        map.getSource("traffic-points")?.setData(trafficData);
      }
    } catch (error) {
      console.error("交通量データの取得に失敗しました:", error);
    }

    // 【実験的機能】観測点に最も近い道路線を推定してハイライトする。
    // Overpass APIの混雑等で失敗することがあるが、その場合も観測点（丸マーカー）の
    // 表示自体には影響させない。
    if (trafficData?.features?.length) {
      try {
        const ways = await fetchNearbyRoadWays(bbox);
        const highlightFeatures = trafficData.features
          .map((feature) => {
            const [lng, lat] = feature.geometry.coordinates[0];
            const nearestWay = findNearestWay({ lat, lng }, ways, ROAD_MATCH_MAX_DISTANCE_METERS);
            if (!nearestWay) return null;
            return {
              type: "Feature",
              geometry: { type: "LineString", coordinates: nearestWay.coordinates },
              properties: feature.properties,
            };
          })
          .filter(Boolean);
        map.getSource("traffic-road-highlight")?.setData({
          type: "FeatureCollection",
          features: highlightFeatures,
        });
      } catch (error) {
        console.error("道路形状の推定表示に失敗しました:", error);
      }
    } else {
      map.getSource("traffic-road-highlight")?.setData(EMPTY_FEATURE_COLLECTION);
    }
  }, []);

  // 現在の表示範囲の標高タイルを取得・デコードし、現在地・AR配置ピンの地表面の
  // 高さ算出に使うサンプラーを更新する（map.queryTerrainElevation()を使わない理由は
  // elevationSamplerRefの定義コメントを参照）。
  const refreshElevationSampler = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    const bbox = {
      minLng: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLng: bounds.getEast(),
      maxLat: bounds.getNorth(),
    };
    try {
      elevationSamplerRef.current = await createElevationSampler(bbox);
      updateLocationMarkerRef.current();
      updateArPlacementMarkersRef.current();
    } catch (error) {
      console.error("標高データの取得に失敗しました:", error);
    }
  }, []);

  // 高度接続線の地表面側の点がクリックされたときに、その地点の標高タイルの高度を表示する
  const showTerrainElevationPopup = useCallback((map, lng, lat) => {
    const elevation = elevationSamplerRef.current(lng, lat);
    terrainElevationPopupRef.current
      ?.setLngLat([lng, lat])
      .setHTML(`<b>地形の標高</b><br>標高タイルの高度 約${Math.round(elevation)}m`)
      .addTo(map);
  }, []);

  // AR配置（ar_placements）を表示範囲内で取得し、ピン(DOM要素)として表示する。
  // 森林簿・地籍と同様に表示範囲(bbox)内のみを取得する。
  const refreshArPlacements = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const markers = arPlacementMarkersRef.current;

    if (!arPlacementsVisibleRef.current) {
      for (const marker of markers.values()) {
        marker.el.remove();
        removeGroundLine(marker.groundLine);
      }
      markers.clear();
      updateArPlacementMarkersRef.current();
      return;
    }

    const bounds = map.getBounds();
    const { data, error } = await supabase.rpc("ar_placements_in_bbox", {
      min_lng: bounds.getWest(),
      min_lat: bounds.getSouth(),
      max_lng: bounds.getEast(),
      max_lat: bounds.getNorth(),
    });
    if (error || !data) return;

    const seenIds = new Set();
    for (const feature of data.features) {
      const { id, lat, lng, altitude } = feature.properties;
      seenIds.add(id);

      const existing = markers.get(id);
      if (existing) {
        existing.lat = lat;
        existing.lng = lng;
        existing.altitude = altitude;
        existing.properties = feature.properties;
        continue;
      }

      const el = createPinMarkerElement(AR_PLACEMENT_MARKER_COLOR);
      map.getCanvasContainer().appendChild(el);
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        const marker = arPlacementMarkersRef.current.get(id);
        if (!marker) return;
        // プライバシー保護のため、緯度・経度は表示しない（ユーザー登録・公開設定の
        // 導入までの暫定対応。将来的にユーザーが公開/非公開を選択できるようにする）。
        setSelectedArPlacement(marker.properties);
        arPlacementPopupRef.current?.setLngLat([marker.lng, marker.lat]).addTo(map);
      });

      const groundLine = createGroundLineElements(groundLinesSvgRef.current, AR_PLACEMENT_MARKER_COLOR);
      groundLine.hitArea.addEventListener("click", (event) => {
        event.stopPropagation();
        showTerrainElevationPopup(map, lng, lat);
      });
      markers.set(id, { el, lat, lng, altitude, properties: feature.properties, groundLine });
    }

    for (const [id, marker] of markers) {
      if (!seenIds.has(id)) {
        marker.el.remove();
        removeGroundLine(marker.groundLine);
        markers.delete(id);
      }
    }

    updateArPlacementMarkersRef.current();
  }, [supabase, showTerrainElevationPopup]);

  // ポップアップの削除ボタンから、削除成功後に呼ばれる。ポップアップを閉じつつ、
  // 表示中のピンをDBの最新状態に合わせて更新する。
  const handleArPlacementDeleted = useCallback(() => {
    arPlacementPopupRef.current?.remove();
    refreshArPlacements();
  }, [refreshArPlacements]);

  // 取得した位置情報（GeolocationCoordinates）をマーカー・ステータス表示に反映する。
  // 常時追跡（watchPosition）と「現在地へ移動」ボタン（getCurrentPosition）の
  // 両方から共通で呼び出す。
  const applyLocationPosition = useCallback((coords) => {
    const { longitude, latitude, altitude } = coords;
    locationPositionRef.current = {
      lng: longitude,
      lat: latitude,
      altitude: altitude === undefined ? null : altitude,
    };
    setLocationStatus(
      locationPositionRef.current.altitude === null
        ? "現在地を表示中（高度は取得できませんでした。地表に表示しています）"
        : `現在地を表示中（高度 約${Math.round(locationPositionRef.current.altitude)}m）`,
    );
    updateLocationMarkerRef.current();
  }, []);

  const handleLocationError = useCallback((error) => {
    const messages = {
      1: "位置情報の利用が許可されませんでした",
      2: "現在地を取得できませんでした",
      3: "現在地の取得がタイムアウトしました",
    };
    setLocationStatus(messages[error.code] ?? "現在地の取得に失敗しました");
  }, []);

  const handleLocateClick = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationStatus("このブラウザは位置情報の取得に対応していません");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        applyLocationPosition(position.coords);
        const map = mapRef.current;
        const { longitude, latitude } = position.coords;
        map?.flyTo({
          center: [longitude, latitude],
          zoom: Math.max(map.getZoom(), 16),
          essential: true,
        });
      },
      handleLocationError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  }, [applyLocationPosition, handleLocationError]);

  // マップのエクスポート（GLB）。three.jsは重いためエクスポート実行時にのみ動的読み込みする。
  const handleExport = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    if (!exportIncludeTerrain && !exportIncludeParcels && !exportIncludeBuildings) {
      setExportStatus(
        "「地形」「森林簿・地籍の押し出しメッシュ」「OSM建物」のいずれかを選択してください",
      );
      return;
    }

    let bbox;
    if (exportRangeMode === "rectangle") {
      if (!exportBbox) {
        setExportStatus("先に地図上で範囲を選択してください");
        return;
      }
      bbox = exportBbox;
    } else {
      const bounds = map.getBounds();
      bbox = {
        minLng: bounds.getWest(),
        minLat: bounds.getSouth(),
        maxLng: bounds.getEast(),
        maxLat: bounds.getNorth(),
      };
    }

    setIsExporting(true);
    try {
      const { exportMapAsGlb, downloadGlb } = await import("./exportGlb");
      const arrayBuffer = await exportMapAsGlb({
        bbox,
        includeTerrain: exportIncludeTerrain,
        includeParcels: exportIncludeParcels,
        includeBuildings: exportIncludeBuildings,
        includeBasemapTexture: exportIncludeTerrain && exportIncludeBasemapTexture,
        basemapKey: basemap,
        supabase,
        onProgress: setExportStatus,
      });
      downloadGlb(arrayBuffer, `geolia_map_${Date.now()}.glb`);
      setExportStatus("エクスポートが完了しました");
    } catch (error) {
      console.error("マップのエクスポートに失敗しました:", error);
      setExportStatus("エクスポートに失敗しました");
    } finally {
      setIsExporting(false);
    }
  }, [
    exportRangeMode,
    exportBbox,
    exportIncludeTerrain,
    exportIncludeParcels,
    exportIncludeBuildings,
    exportIncludeBasemapTexture,
    basemap,
    supabase,
  ]);

  // 起動時、現在地が取得できるかどうかを先に判定しておく（現在地が取れればそこを
  // 中心とした上面表示、取れなければ町全体の俯瞰表示にフォールバックする）。
  // 地図本体の初期化はこの判定が終わるまで待つため、初期表示が後から現在地へ
  // 飛ぶような見え方にはならない。
  const [initialCameraReady, setInitialCameraReady] = useState(false);
  const initialCameraRef = useRef(FALLBACK_INITIAL_CAMERA);
  useEffect(() => {
    let cancelled = false;
    getInitialCameraFromLocation().then((camera) => {
      if (cancelled) return;
      initialCameraRef.current = camera ?? FALLBACK_INITIAL_CAMERA;
      setInitialCameraReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 地図の初期化（初期カメラ位置の判定が終わったあとに一度だけ）
  useEffect(() => {
    if (!initialCameraReady) return;

    const map = new MapLibreMap({
      container: mapContainerRef.current,
      style: baseStyle("osm"),
      maxPitch: 75,
      ...initialCameraRef.current,
    });
    // 画面サイズによっては「町全体を映す」ためのズームが森林簿・地籍データの
    // 表示しきい値(MIN_ZOOM_FOR_DATA)を下回ることがある。その場合はデータが
    // 最初から見えることを優先し、しきい値まで寄せる（中心はそのまま）。
    if (map.getZoom() < MIN_ZOOM_FOR_DATA) {
      map.setZoom(MIN_ZOOM_FOR_DATA);
    }
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      window.__geoliaMap = map;
    }
    skipNextBasemapChangeRef.current = true;

    map.addControl(
      new NavigationControl({ visualizePitch: true, showCompass: true }),
      "top-right",
    );
    map.addControl(new PitchControl(), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
    const cursorInfoControl = new CursorInfoControl();
    map.addControl(cursorInfoControl, "bottom-left");
    cursorInfoControlRef.current = cursorInfoControl;

    // マップエクスポート機能の「矩形選択」用オーバーレイのソースID
    const selectionRectSourceId = "selection-rect";

    // 'load' や 'styledata' 単体では、環境によって発火するタイミングが不安定
    // （発火が遅い・まれに拾えないことがある）ため、複数の手段を併用して
    // 確実にレイヤーを追加できるようにする。ガード（!map.getSource）により
    // 重複追加は起きない。
    const tryInitLayers = () => {
      if (map.getSource("forest-a")) return;
      if (!map.isStyleLoaded()) return;
      addDataLayers(map, "koaza");
      try {
        applyTerrain(map, terrainEnabledRef.current, terrainExaggerationRef.current);
      } catch (error) {
        console.error("地形設定の初期化に失敗しました:", error);
      }
      map.addSource(selectionRectSourceId, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
      map.addLayer({
        id: "selection-rect-fill",
        type: "fill",
        source: selectionRectSourceId,
        paint: { "fill-color": "#1e88e5", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: "selection-rect-line",
        type: "line",
        source: selectionRectSourceId,
        paint: { "line-color": "#1e88e5", "line-width": 2 },
      });

      // JARTIC道路交通量（上り+下りの合計台数/5分で色分け）
      map.addSource("traffic-points", { type: "geojson", data: EMPTY_FEATURE_COLLECTION });

      // 【実験的機能】観測点に最も近いOpenStreetMapの道路線を推定してハイライトする
      // （roadSegmentMatch.js参照。公式な区間境界と異なる場合がある近似表示）。
      map.addSource("traffic-road-highlight", { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
      map.addLayer({
        id: "traffic-road-highlight-line",
        type: "line",
        source: "traffic-road-highlight",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width": 6,
          "line-color": TRAFFIC_COLOR_EXPRESSION,
          "line-opacity": 0.85,
        },
      });

      map.addLayer({
        id: "traffic-points-fill",
        type: "circle",
        source: "traffic-points",
        paint: {
          "circle-radius": 7,
          "circle-color": TRAFFIC_COLOR_EXPRESSION,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#fff",
        },
      });

      refreshData();
      refreshArPlacements();
      refreshTraffic();
      refreshElevationSampler();
    };

    map.on("load", tryInitLayers);
    map.on("styledata", tryInitLayers);
    map.on("idle", tryInitLayers);
    const initPollTimer = setInterval(tryInitLayers, 200);
    const initPollTimeout = setTimeout(() => clearInterval(initPollTimer), 15000);

    let debounceTimer;
    map.on("moveend", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        refreshData();
        refreshArPlacements();
        refreshTraffic();
        refreshElevationSampler();
      }, 300);
    });

    const popup = new Popup({ closeButton: true, closeOnClick: true });
    map.on("click", (event) => {
      const layerIds = [
        "forest-fill-a",
        "forest-fill-b",
        "land-fill-a",
        "land-fill-b",
        "buildings-fill-a",
        "buildings-fill-b",
        "traffic-points-fill",
      ].filter((id) => map.getLayer(id));
      const features = layerIds.length ? map.queryRenderedFeatures(event.point, { layers: layerIds }) : [];

      // 森林簿・地籍・建物のいずれも無い（=AR配置ピンでもない）場所をクリックした場合は、
      // 一人称視点の開始地点として選ぶ（AR配置ピンは独自のクリック処理を持ち、ここには来ない）。
      if (!features.length) {
        setFirstPersonPendingOrigin({ lng: event.lngLat.lng, lat: event.lngLat.lat });
        return;
      }

      const feature = features[0];
      let html;
      if (feature.layer.id.startsWith("forest-fill")) {
        const p = feature.properties;
        html = `<b>森林簿</b><br>林班 ${p.rinhan ?? "-"}　小班 ${p.shohan ?? "-"}<br>施業番 ${p.sehyoban ?? "-"}`;
      } else if (feature.layer.id.startsWith("buildings-fill")) {
        const p = feature.properties;
        const heightText =
          p.height_source === "tag"
            ? `${p.height}m`
            : p.height_source === "levels"
              ? `約${p.height}m（階数から推定）`
              : `約${p.height}m（推定値）`;
        const spotBadge = p.name
          ? `<span style="font-size:11px;color:${NAMED_BUILDING_COLOR};">注目スポット</span><br>`
          : "";
        html = `${spotBadge}<b>${p.name ?? "建物"}</b><br>高さ ${heightText}<br><span style="font-size:11px;color:#888;">出典: OpenStreetMap</span>`;
      } else if (feature.layer.id === "traffic-points-fill") {
        const p = feature.properties;
        html = `<b>道路交通量</b><br>${p.roadTypeLabel}<br>上り ${p.upTotal}台／下り ${p.downTotal}台（5分間）<br>観測時刻 ${formatJarticTimeCode(p.timeCode)}<br><span style="font-size:11px;color:#888;">出典: JARTIC（日本道路交通情報センター）</span>`;
      } else if (feature.layer.id.startsWith("land-fill")) {
        const p = feature.properties;
        html = `<b>地籍筆</b><br>小字 ${p.koaza_name ?? "-"}　地番 ${p.chiban ?? "-"}<br>精度区分 ${p.precision_class ?? "-"}`;
      }
      popup.setLngLat(event.lngLat).setHTML(html).addTo(map);
    });

    // 高度のあるマーカー（現在地・AR配置）について、地形上の地点から先端までを結ぶ線を
    // 描画するためのSVGオーバーレイ。マーカー本体と同様にキャンバスコンテナに重ねる。
    const groundLinesSvg = document.createElementNS(SVG_NS, "svg");
    groundLinesSvg.setAttribute(
      "style",
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;",
    );
    map.getCanvasContainer().appendChild(groundLinesSvg);
    groundLinesSvgRef.current = groundLinesSvg;

    // 現在地マーカー（DOM要素）。地形の起伏やズーム・傾きが変わるたびに
    // 位置を再計算する必要があるため、レイヤーではなくキャンバスコンテナに
    // 直接重ねて、地図の描画イベントに合わせて自前で位置を更新する。
    const locationMarkerEl = createPinMarkerElement(LOCATION_MARKER_COLOR);
    map.getCanvasContainer().appendChild(locationMarkerEl);
    locationMarkerElRef.current = locationMarkerEl;
    const locationGroundLine = createGroundLineElements(groundLinesSvg, LOCATION_MARKER_COLOR);
    terrainElevationPopupRef.current = new Popup({ closeButton: true, closeOnClick: true });
    locationGroundLine.hitArea.addEventListener("click", (event) => {
      event.stopPropagation();
      const pos = locationPositionRef.current;
      if (!pos) return;
      showTerrainElevationPopup(map, pos.lng, pos.lat);
    });

    // 実際にmaplibre-glが地形を描画する高さ（標高タイルの値 × 強調倍率。
    // 地形表現が無効なときは平面表示になるため0）に合わせる。
    const getRenderedGroundElevation = (lng, lat) =>
      terrainEnabledRef.current ? elevationSamplerRef.current(lng, lat) * terrainExaggerationRef.current : 0;

    // GPS高度など実測の高度も、地形と同じ強調倍率を掛けて表示する。強調していない
    // 地形の上に強調していない高度のピンを乗せると、高度が地形の標高と近い（＝実際は
    // 地表付近にいる）場合でも、強調された地形の方が高く描画されて地中に沈んで見える
    // など不自然になるため（地形表現が無効なときは倍率を掛けない実測値のまま表示する）。
    const getRenderedAltitude = (rawAltitude) =>
      terrainEnabledRef.current ? rawAltitude * terrainExaggerationRef.current : rawAltitude;

    const updateLocationMarkerElement = () => {
      const pos = locationPositionRef.current;
      if (!pos) {
        locationMarkerEl.style.display = "none";
        updateGroundLine(locationGroundLine, null, null);
        return;
      }
      const hasAltitude = pos.altitude !== null;
      const groundElevation = getRenderedGroundElevation(pos.lng, pos.lat);
      const elevation = hasAltitude ? getRenderedAltitude(pos.altitude) : groundElevation;
      const point = projectAtElevation(map, pos.lng, pos.lat, elevation);
      locationMarkerEl.style.display = "";
      locationMarkerEl.style.transform = `translate(${point.x}px, ${point.y}px)`;

      if (hasAltitude) {
        const groundPoint = projectAtElevation(map, pos.lng, pos.lat, groundElevation);
        updateGroundLine(locationGroundLine, groundPoint, point);
      } else {
        updateGroundLine(locationGroundLine, null, null);
      }
    };
    updateLocationMarkerRef.current = updateLocationMarkerElement;
    map.on("move", updateLocationMarkerElement);
    map.on("render", updateLocationMarkerElement);

    // AR配置ピン（DOM要素）。現在地マーカーと同様に、地図の描画イベントに合わせて
    // 位置（3次元位置。高度が無い場合は地表面）を自前で更新する。
    // クリーンアップ時にrefの最新値ではなくマウント時点のMapを確実に片付けられるよう、
    // ローカル変数として捕捉しておく。
    const arPlacementMarkers = arPlacementMarkersRef.current;
    const arPlacementPopup = new Popup({ closeButton: true, closeOnClick: true }).setDOMContent(
      arPlacementPopupContainer,
    );
    arPlacementPopup.on("close", () => setSelectedArPlacement(null));
    arPlacementPopupRef.current = arPlacementPopup;
    const updateArPlacementMarkers = () => {
      for (const marker of arPlacementMarkers.values()) {
        const hasAltitude = marker.altitude !== null && marker.altitude !== undefined;
        const groundElevation = getRenderedGroundElevation(marker.lng, marker.lat);
        const elevation = hasAltitude ? getRenderedAltitude(marker.altitude) : groundElevation;
        const point = projectAtElevation(map, marker.lng, marker.lat, elevation);
        marker.el.style.display = "";
        marker.el.style.transform = `translate(${point.x}px, ${point.y}px)`;

        if (hasAltitude) {
          const groundPoint = projectAtElevation(map, marker.lng, marker.lat, groundElevation);
          updateGroundLine(marker.groundLine, groundPoint, point);
        } else {
          updateGroundLine(marker.groundLine, null, null);
        }
      }
    };
    updateArPlacementMarkersRef.current = updateArPlacementMarkers;
    map.on("move", updateArPlacementMarkers);
    map.on("render", updateArPlacementMarkers);

    const locationPopup = new Popup({ closeButton: true, closeOnClick: true });
    locationMarkerEl.addEventListener("click", (event) => {
      event.stopPropagation();
      const pos = locationPositionRef.current;
      if (!pos) return;
      const altitudeText =
        pos.altitude === null ? "高度情報なし" : `高度 約${Math.round(pos.altitude)}m`;
      const html = `<b>現在地</b><br>緯度 ${pos.lat.toFixed(6)}　経度 ${pos.lng.toFixed(6)}<br>${altitudeText}`;
      locationPopup.setLngLat([pos.lng, pos.lat]).setHTML(html).addTo(map);
    });

    // マップエクスポート機能の「矩形選択」用オーバーレイ。
    // ドラッグ中の矩形をGeoJSONで描画し、mouseup時に確定したbboxをstateへ反映する。
    // ソース・レイヤーの追加自体はスタイル読み込み完了後まで待つ必要があるため、
    // tryInitLayers（森林簿・地籍・地形と同じ、確実に一度だけ実行される初期化処理）に含める。
    let selectionStart = null;
    const updateSelectionRect = (start, end) => {
      const minLng = Math.min(start.lng, end.lng);
      const maxLng = Math.max(start.lng, end.lng);
      const minLat = Math.min(start.lat, end.lat);
      const maxLat = Math.max(start.lat, end.lat);
      const coords = [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ];
      map.getSource(selectionRectSourceId)?.setData({
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } },
        ],
      });
      return { minLng, minLat, maxLng, maxLat };
    };
    const handleSelectionMouseMove = (event) => {
      if (!selectionStart) return;
      updateSelectionRect(selectionStart, event.lngLat);
    };
    const handleSelectionMouseUp = (event) => {
      if (!selectionStart) return;
      const bbox = updateSelectionRect(selectionStart, event.lngLat);
      selectionStart = null;
      map.off("mousemove", handleSelectionMouseMove);
      map.off("mouseup", handleSelectionMouseUp);
      map.dragPan.enable();
      map.dragRotate.enable();
      setExportBbox(bbox);
      setIsSelectingRectangle(false);
    };
    const handleSelectionMouseDown = (event) => {
      if (!selectionModeRef.current) return;
      event.preventDefault();
      selectionStart = event.lngLat;
      map.dragPan.disable();
      map.dragRotate.disable();
      map.on("mousemove", handleSelectionMouseMove);
      map.on("mouseup", handleSelectionMouseUp);
    };
    map.on("mousedown", handleSelectionMouseDown);

    // カーソル位置の緯度経度・標高を左下のコントロールに表示する
    const handleCursorMove = (event) => {
      const { lng, lat } = event.lngLat;
      const elevation = elevationSamplerRef.current(lng, lat);
      cursorInfoControlRef.current?.update(lng, lat, elevation);
    };
    const handleCursorLeave = () => {
      cursorInfoControlRef.current?.clear();
    };
    map.on("mousemove", handleCursorMove);
    map.on("mouseout", handleCursorLeave);

    // 右ドラッグ／Ctrl+ドラッグに加えて、スクロールボタン（ホイールクリック）を
    // 押しながらのドラッグでも地図の回転・傾きを操作できるようにする（3ボタンマウス向け）。
    // なお、MacBookのトラックパッドは既定で「2本指クリック」が副ボタン（右クリック）に
    // 割り当てられているため、2本指タップしながらのドラッグで既存の右ドラッグ操作と同様に
    // 回転・傾きの操作ができる。スマートフォン等のタッチ端末では、maplibre-glが標準で
    // 対応しているピンチ操作（ズーム）・2本指ひねり（回転）・2本指の垂直ドラッグ（傾き）を
    // そのまま利用できる。
    let middleButtonDragActive = false;
    let middleButtonLastPoint = null;
    const handleMiddleButtonDown = (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      middleButtonDragActive = true;
      middleButtonLastPoint = { x: event.clientX, y: event.clientY };
    };
    const handleMiddleButtonMove = (event) => {
      if (!middleButtonDragActive || !middleButtonLastPoint) return;
      const dx = event.clientX - middleButtonLastPoint.x;
      const dy = event.clientY - middleButtonLastPoint.y;
      middleButtonLastPoint = { x: event.clientX, y: event.clientY };
      map.setBearing(map.getBearing() - dx * MIDDLE_BUTTON_ROTATE_SENSITIVITY);
      map.setPitch(
        Math.min(Math.max(map.getPitch() + dy * MIDDLE_BUTTON_PITCH_SENSITIVITY, 0), map.getMaxPitch()),
      );
    };
    const handleMiddleButtonUp = () => {
      middleButtonDragActive = false;
      middleButtonLastPoint = null;
    };
    const canvasContainer = map.getCanvasContainer();
    canvasContainer.addEventListener("mousedown", handleMiddleButtonDown);
    window.addEventListener("mousemove", handleMiddleButtonMove);
    window.addEventListener("mouseup", handleMiddleButtonUp);

    return () => {
      clearTimeout(debounceTimer);
      clearInterval(initPollTimer);
      clearTimeout(initPollTimeout);
      map.off("move", updateLocationMarkerElement);
      map.off("render", updateLocationMarkerElement);
      map.off("move", updateArPlacementMarkers);
      map.off("render", updateArPlacementMarkers);
      map.off("mousedown", handleSelectionMouseDown);
      map.off("mousemove", handleSelectionMouseMove);
      map.off("mouseup", handleSelectionMouseUp);
      map.off("mousemove", handleCursorMove);
      map.off("mouseout", handleCursorLeave);
      cursorInfoControlRef.current = null;
      canvasContainer.removeEventListener("mousedown", handleMiddleButtonDown);
      window.removeEventListener("mousemove", handleMiddleButtonMove);
      window.removeEventListener("mouseup", handleMiddleButtonUp);
      locationMarkerEl.remove();
      locationMarkerElRef.current = null;
      for (const marker of arPlacementMarkers.values()) marker.el.remove();
      arPlacementMarkers.clear();
      groundLinesSvg.remove();
      groundLinesSvgRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCameraReady]);

  // 背景地図の切り替え
  // スタイル全体を作り直す(setStyle)と、森林簿・地籍・地形などのカスタムレイヤーが
  // 一旦消えて再取得されるまで不安定に見えるため、背景ラスターレイヤーだけを
  // 削除・再追加する（他のレイヤー・データには一切触れないので切り替えは安定する）。
  // source.setTiles()は、inline指定のtilesを持つラスターソースの実行時更新に
  // maplibre-gl v4.7.1で不具合があり反映されなかったため、この方式を採用する。
  // 初回マウント時（ソース未作成）はスキップする。マウント時に毎回リセットするため
  // React Strict Modeでの二重マウントでも安全。
  useEffect(() => {
    if (skipNextBasemapChangeRef.current) {
      skipNextBasemapChangeRef.current = false;
      return;
    }
    const map = mapRef.current;
    if (!map || !map.getSource("gsi-base")) return;

    const tile = BASEMAP_TILES[basemap];
    if (map.getLayer("gsi-base-layer")) map.removeLayer("gsi-base-layer");
    map.removeSource("gsi-base");
    map.addSource("gsi-base", {
      type: "raster",
      tiles: tile.urls,
      tileSize: 256,
      maxzoom: tile.maxzoom,
      attribution: tile.attribution,
    });
    // 森林簿レイヤーより手前(下)に挿入し、背景として一番下に来るようにする
    const beforeId = map.getLayer("forest-fill-a") ? "forest-fill-a" : undefined;
    map.addLayer({ id: "gsi-base-layer", type: "raster", source: "gsi-base" }, beforeId);
  }, [basemap]);

  // レイヤー表示のオン/オフ
  useEffect(() => {
    refreshData();
  }, [forestVisible, landVisible, buildingsVisible, refreshData]);

  useEffect(() => {
    refreshTraffic();
  }, [trafficVisible, refreshTraffic]);

  // 【実験的機能】推定した道路ハイライトを点滅させる（交通量に応じた強調表現）。
  // MapLibreに時間経過のアニメーション機能は無いため、line-opacityを一定間隔で
  // 切り替えることで表現する。
  useEffect(() => {
    if (!trafficVisible) return undefined;
    const map = mapRef.current;
    if (!map) return undefined;

    let isDim = false;
    const intervalId = setInterval(() => {
      if (!map.getLayer("traffic-road-highlight-line")) return;
      isDim = !isDim;
      map.setPaintProperty("traffic-road-highlight-line", "line-opacity", isDim ? 0.25 : 0.85);
    }, 600);

    return () => clearInterval(intervalId);
  }, [trafficVisible]);

  // AR配置ピンの表示オン/オフ
  useEffect(() => {
    refreshArPlacements();
  }, [arPlacementsVisible, refreshArPlacements]);

  // 筆レイヤーの色分けモード（表示・非表示どちらのバッファにも適用しておく）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const colorExpr = [
      "get",
      landColorMode === "koaza" ? "color_koaza" : "color_seido",
    ];
    for (const buffer of ["a", "b"]) {
      const layerId = `land-fill-${buffer}`;
      if (map.getLayer(layerId)) {
        map.setPaintProperty(layerId, "fill-extrusion-color", colorExpr);
      }
    }
  }, [landColorMode]);

  // 標高タイルによる地形起伏（試験的機能）
  // isStyleLoaded()は環境によって発火が遅れ信頼できないため使わず、
  // 「読み込み未完了で失敗した場合はtry/catchで無視する」方式にする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    try {
      applyTerrain(map, terrainEnabled, terrainExaggeration);
    } catch (error) {
      console.error("地形設定の変更に失敗しました:", error);
    }
  }, [terrainEnabled, terrainExaggeration]);

  // 現在地の常時追跡表示。マーカー自体の見た目・配置ロジックはapplyLocationPositionと
  // updateLocationMarkerElement（地図初期化時に定義）に共通化してある。
  // 高度が取得できる場合はその高度の3次元位置に、取得できない場合は地表面の位置に
  // アイコンが表示される（updateLocationMarkerElement内のprojectAtElevationで判定）。
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      return undefined;
    }

    locationWatchIdRef.current = navigator.geolocation.watchPosition(
      (position) => applyLocationPosition(position.coords),
      handleLocationError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );

    return () => {
      if (locationWatchIdRef.current !== null) {
        navigator.geolocation.clearWatch(locationWatchIdRef.current);
        locationWatchIdRef.current = null;
      }
    };
  }, [applyLocationPosition, handleLocationError]);

  // 範囲選択（矩形）モード中はカーソルをcrosshairにして分かりやすくする
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = isSelectingRectangle ? "crosshair" : "";
  }, [isSelectingRectangle]);

  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        className={styles.toggleButton}
        onClick={() => setSidebarOpen((current) => !current)}
        aria-label={sidebarOpen ? "サイドメニューを閉じる" : "サイドメニューを開く"}
        aria-expanded={sidebarOpen}
      >
        <span className={`${styles.hamburgerIcon} ${sidebarOpen ? styles.open : ""}`}>
          <span />
          <span />
          <span />
        </span>
      </button>

      <div
        className={`${styles.backdrop} ${sidebarOpen ? styles.open : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside className={`${styles.sidePane} ${sidebarOpen ? styles.open : ""}`}>
        <h1 className={styles.title}>3Dマップ</h1>

        <section className={styles.section}>
          <h2>背景地図</h2>
          <select value={basemap} onChange={(event) => setBasemap(event.target.value)}>
            {Object.entries(BASEMAP_TILES).map(([key, tile]) => (
              <option key={key} value={key}>
                {tile.label}
              </option>
            ))}
          </select>
        </section>

        <section className={styles.section}>
          <h2>レイヤー</h2>
          <label>
            <input
              type="checkbox"
              checked={forestVisible}
              onChange={(event) => setForestVisible(event.target.checked)}
            />
            森林簿（林班）
          </label>
          <label>
            <input
              type="checkbox"
              checked={landVisible}
              onChange={(event) => setLandVisible(event.target.checked)}
            />
            地籍 筆
          </label>
          <label>
            <input
              type="checkbox"
              checked={arPlacementsVisible}
              onChange={(event) => setArPlacementsVisible(event.target.checked)}
            />
            AR配置
          </label>
          <label>
            <input
              type="checkbox"
              checked={buildingsVisible}
              onChange={(event) => setBuildingsVisible(event.target.checked)}
            />
            OSM建物
          </label>
          {buildingsVisible && (
            <p className={styles.status}>
              名称が登録されている建物（注目スポット）は
              <span style={{ color: NAMED_BUILDING_COLOR, fontWeight: 700 }}>オレンジ色</span>
              で表示されます
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={trafficVisible}
              onChange={(event) => setTrafficVisible(event.target.checked)}
            />
            道路交通量（JARTIC）
          </label>
          {trafficVisible && (
            <p className={styles.status}>
              5分ごとの交通量（上り・下り合計台数）を色分け表示します。データ提供:
              JARTIC（日本道路交通情報センター）
              <br />
              ⚠️ 点滅する道路のハイライトは試験的機能です。観測地点に最も近い
              OpenStreetMap上の道路を推定して表示しているだけで、実際の公式な調査区間とは
              異なる場合があります。
            </p>
          )}
        </section>

        <section className={styles.section}>
          <h2>現在地</h2>
          {locationStatus && <p className={styles.status}>{locationStatus}</p>}
        </section>

        {landVisible && (
          <section className={styles.section}>
            <h2>筆レイヤーの色分け</h2>
            <select
              value={landColorMode}
              onChange={(event) => setLandColorMode(event.target.value)}
            >
              <option value="koaza">小字ごと</option>
              <option value="seido">精度区分ごと</option>
            </select>
          </section>
        )}

        <section className={styles.section}>
          <h2>地形表現（試験的）</h2>
          <label>
            <input
              type="checkbox"
              checked={terrainEnabled}
              onChange={(event) => setTerrainEnabled(event.target.checked)}
            />
            標高タイルによる起伏を有効にする
          </label>
          {terrainEnabled && (
            <>
              <label className={styles.subOption}>
                標高の強調: {terrainExaggeration.toFixed(1)}倍
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.1}
                  value={terrainExaggeration}
                  onChange={(event) => setTerrainExaggeration(Number(event.target.value))}
                />
              </label>
              <p className={styles.status}>
                標高データはズームレベル12以上でのみ表示されます
              </p>
            </>
          )}
        </section>

        <section className={styles.section}>
          <h2>マップのエクスポート（GLB）</h2>
          <label>
            <input
              type="radio"
              name="exportRangeMode"
              checked={exportRangeMode === "current"}
              onChange={() => setExportRangeMode("current")}
            />
            現在の表示範囲
          </label>
          <label>
            <input
              type="radio"
              name="exportRangeMode"
              checked={exportRangeMode === "rectangle"}
              onChange={() => setExportRangeMode("rectangle")}
            />
            矩形選択
          </label>
          {exportRangeMode === "rectangle" && (
            <>
              <button
                type="button"
                className={styles.locateButton}
                onClick={() => setIsSelectingRectangle(true)}
                disabled={isSelectingRectangle}
              >
                {isSelectingRectangle ? "地図をドラッグして範囲を指定..." : "範囲を選択"}
              </button>
              {exportBbox && !isSelectingRectangle && (
                <p className={styles.status}>範囲を選択済みです</p>
              )}
            </>
          )}

          <label>
            <input
              type="checkbox"
              checked={exportIncludeTerrain}
              onChange={(event) => setExportIncludeTerrain(event.target.checked)}
            />
            地形（標高メッシュ）
          </label>
          {exportIncludeTerrain && (
            <label className={styles.subOption}>
              <input
                type="checkbox"
                checked={exportIncludeBasemapTexture}
                onChange={(event) => setExportIncludeBasemapTexture(event.target.checked)}
              />
              背景地図をテクスチャとして貼り付ける
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={exportIncludeParcels}
              onChange={(event) => setExportIncludeParcels(event.target.checked)}
            />
            森林簿・地籍の押し出しメッシュ
          </label>
          <label>
            <input
              type="checkbox"
              checked={exportIncludeBuildings}
              onChange={(event) => setExportIncludeBuildings(event.target.checked)}
            />
            OSM建物
          </label>

          <button
            type="button"
            className={styles.locateButton}
            onClick={handleExport}
            disabled={isExporting}
          >
            {isExporting ? "エクスポート中..." : "GLBをエクスポート"}
          </button>
          {exportStatus && <p className={styles.status}>{exportStatus}</p>}
        </section>

        {status && <p className={styles.status}>{status}</p>}

        <p className={styles.hint}>
          {isTouchDevice
            ? "1本指ドラッグ: パン / 2本指ピンチ: ズーム / 2本指のひねり・上下ドラッグ: 回転・傾き（右上のボタンでも傾き調整可） / タップ: 区画情報"
            : "左ドラッグ: パン / 右ドラッグ・Ctrl+ドラッグ・ホイールクリック+ドラッグ（MacBookは2本指クリック+ドラッグ）: 回転・傾き / ホイール: ズーム / クリック: 区画情報"}
        </p>

        <p className={styles.attribution}>
          背景地図の出典:{" "}
          <span
            dangerouslySetInnerHTML={{ __html: BASEMAP_TILES[basemap].attribution }}
          />
          。地形表現は
          <a
            href="https://maps.gsi.go.jp/development/ichiran.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            地理院タイル
          </a>
          の標高タイルを加工して利用しています。
          {buildingsVisible && (
            <>
              建物データは
              <span dangerouslySetInnerHTML={{ __html: OSM_ATTRIBUTION }} />
              を加工して利用しています。
            </>
          )}
        </p>
      </aside>

      <div ref={mapContainerRef} className={styles.mapContainer} />

      {selectedArPlacement &&
        arPlacementPopupContainer &&
        createPortal(
          <ArPlacementPopupContent
            placement={selectedArPlacement}
            previewUrl={
              selectedArPlacement.preview_storage_path
                ? supabase.storage.from("ar-assets").getPublicUrl(selectedArPlacement.preview_storage_path)
                    .data.publicUrl
                : null
            }
            dataUrl={
              selectedArPlacement.storage_path
                ? supabase.storage.from("ar-assets").getPublicUrl(selectedArPlacement.storage_path).data
                    .publicUrl
                : null
            }
            motionAssetUrl={
              selectedArPlacement.motion_storage_path
                ? supabase.storage.from("ar-motion-assets").getPublicUrl(
                    selectedArPlacement.motion_storage_path,
                  ).data.publicUrl
                : null
            }
            onDeleted={handleArPlacementDeleted}
          />,
          arPlacementPopupContainer,
        )}

      <button
        type="button"
        className={styles.locateFab}
        onClick={handleLocateClick}
        aria-label="現在地へ移動"
        title="現在地へ移動"
      >
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" fill="currentColor" />
          <path
            fill="currentColor"
            d="M12 3a1 1 0 0 1 1 1v1.06A7.002 7.002 0 0 1 18.94 11H20a1 1 0 1 1 0 2h-1.06A7.002 7.002 0 0 1 13 18.94V20a1 1 0 1 1-2 0v-1.06A7.002 7.002 0 0 1 5.06 13H4a1 1 0 1 1 0-2h1.06A7.002 7.002 0 0 1 11 5.06V4a1 1 0 0 1 1-1Zm0 3.9A5.1 5.1 0 1 0 12 17.1 5.1 5.1 0 0 0 12 6.9Z"
          />
        </svg>
      </button>

      {firstPersonOrigin && (
        <FirstPersonView
          origin={firstPersonOrigin}
          forestVisible={forestVisible}
          landVisible={landVisible}
          landColorMode={landColorMode}
          buildingsVisible={buildingsVisible}
          basemap={basemap}
          supabase={supabase}
          onClose={() => setFirstPersonOrigin(null)}
        />
      )}
    </div>
  );
}
