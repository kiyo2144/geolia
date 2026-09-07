"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createClient } from "@/lib/supabase/client";
import styles from "./MapView.module.css";

// v6は最新すぎてバンドラー環境でのWorker解決やfill-extrusion描画に問題があったため、
// map_overlay.html（既存プロトタイプ）でも実績のあるv4.7.1系を使用する。
const { Map: MapLibreMap, NavigationControl, ScaleControl, Popup } = maplibregl;

const GSI_TILES = {
  pale: {
    url: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
    maxzoom: 18,
  },
  std: {
    url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
    maxzoom: 18,
  },
  photo: {
    url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
    maxzoom: 18,
  },
};

const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>';

// 国土地理院の標高タイルはCORSヘッダーを返さずブラウザから直接fetchできないため、
// 同一オリジンのAPIルート（app/api/dem-tile）でMapbox Terrain-RGB形式に変換して配信する。
const DEM_TILE_URL = "/api/dem-tile/{z}/{x}/{y}.png";

const MIN_ZOOM_FOR_DATA = 13;

// 平泉町の森林簿・地籍データの実際の範囲（南西・北東の緯度経度）。
// forest_parcels / land_parcels 全件のジオメトリから算出した実測値。
const HIRAIZUMI_DATA_BOUNDS = [
  [141.0063447050003, 38.949578826], // 南西
  [141.1919757, 39.028813277000005], // 北東
];

// パン（地図の移動）を許可する範囲。データ範囲より少し広めに余裕を持たせる。
const HIRAIZUMI_MAX_BOUNDS = [
  [140.95, 38.92], // 南西
  [141.25, 39.06], // 北東
];

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };

function baseStyle(kind) {
  const tile = GSI_TILES[kind];
  return {
    version: 8,
    sources: {
      "gsi-base": {
        type: "raster",
        tiles: [tile.url],
        tileSize: 256,
        maxzoom: tile.maxzoom,
        attribution: GSI_ATTRIBUTION,
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
    color: ["get", "color"],
  },
  land: {
    color: (landColorMode) => [
      "get",
      landColorMode === "koaza" ? "color_koaza" : "color_seido",
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
          "fill-extrusion-color":
            key === "land"
              ? BUFFER_LAYER_CONFIG.land.color(landColorMode)
              : BUFFER_LAYER_CONFIG.forest.color,
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-opacity": 0.85,
        },
      });
    }
  }
}

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

function clearBufferData(map, key, bufferRef) {
  const activeBuffer = bufferRef.current;
  map.getSource(`${key}-${activeBuffer}`)?.setData(EMPTY_FEATURE_COLLECTION);
  const otherBuffer = activeBuffer === "a" ? "b" : "a";
  map.getSource(`${key}-${otherBuffer}`)?.setData(EMPTY_FEATURE_COLLECTION);
}

export default function MapView() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const skipNextBasemapChangeRef = useRef(true);
  const supabaseRef = useRef(null);
  if (!supabaseRef.current) {
    supabaseRef.current = createClient();
  }

  const [basemap, setBasemap] = useState("pale");
  const [forestVisible, setForestVisible] = useState(true);
  const [landVisible, setLandVisible] = useState(false);
  const [landColorMode, setLandColorMode] = useState("koaza");
  const [terrainEnabled, setTerrainEnabled] = useState(false);
  const [status, setStatus] = useState("");

  const latestFlagsRef = useRef({ forestVisible, landVisible });
  useEffect(() => {
    latestFlagsRef.current = { forestVisible, landVisible };
  }, [forestVisible, landVisible]);

  // 現在どちらのバッファ(a/b)が表示側になっているかを記録する
  const forestBufferRef = useRef("a");
  const landBufferRef = useRef("a");

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
    const { forestVisible: showForest, landVisible: showLand } =
      latestFlagsRef.current;

    setStatus("読み込み中...");
    const supabase = supabaseRef.current;

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
    await Promise.all(tasks);
    setStatus("");
  }, []);

  // 地図の初期化（マウント時に一度だけ）
  useEffect(() => {
    const map = new MapLibreMap({
      container: mapContainerRef.current,
      style: baseStyle("pale"),
      bounds: HIRAIZUMI_DATA_BOUNDS,
      fitBoundsOptions: { padding: 40 },
      maxBounds: HIRAIZUMI_MAX_BOUNDS,
      pitch: 50,
      bearing: -10,
      maxPitch: 75,
    });
    // 画面サイズによっては「町全体を映す」ためのズームが森林簿・地籍データの
    // 表示しきい値(MIN_ZOOM_FOR_DATA)を下回ることがある。その場合はデータが
    // 最初から見えることを優先し、しきい値まで寄せる（中心はfitBoundsの結果のまま）。
    if (map.getZoom() < MIN_ZOOM_FOR_DATA) {
      map.setZoom(MIN_ZOOM_FOR_DATA);
    }
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      window.__geoliaMap = map;
    }
    skipNextBasemapChangeRef.current = true;

    map.addControl(
      new NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");

    // 'load' や 'styledata' 単体では、環境によって発火するタイミングが不安定
    // （発火が遅い・まれに拾えないことがある）ため、複数の手段を併用して
    // 確実にレイヤーを追加できるようにする。ガード（!map.getSource）により
    // 重複追加は起きない。
    const tryInitLayers = () => {
      if (map.getSource("forest-a")) return;
      if (!map.isStyleLoaded()) return;
      addDataLayers(map, "koaza");
      refreshData();
    };

    map.on("load", tryInitLayers);
    map.on("styledata", tryInitLayers);
    map.on("idle", tryInitLayers);
    const initPollTimer = setInterval(tryInitLayers, 200);
    const initPollTimeout = setTimeout(() => clearInterval(initPollTimer), 15000);

    let debounceTimer;
    map.on("moveend", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refreshData, 300);
    });

    const popup = new Popup({ closeButton: true, closeOnClick: true });
    map.on("click", (event) => {
      const layerIds = [
        "forest-fill-a",
        "forest-fill-b",
        "land-fill-a",
        "land-fill-b",
      ].filter((id) => map.getLayer(id));
      if (!layerIds.length) return;
      const features = map.queryRenderedFeatures(event.point, {
        layers: layerIds,
      });
      if (!features.length) return;

      const feature = features[0];
      let html;
      if (feature.layer.id.startsWith("forest-fill")) {
        const p = feature.properties;
        html = `<b>森林簿</b><br>林班 ${p.rinhan ?? "-"}　小班 ${p.shohan ?? "-"}<br>施業番 ${p.sehyoban ?? "-"}`;
      } else {
        const p = feature.properties;
        html = `<b>地籍筆</b><br>小字 ${p.koaza_name ?? "-"}　地番 ${p.chiban ?? "-"}<br>精度区分 ${p.precision_class ?? "-"}`;
      }
      popup.setLngLat(event.lngLat).setHTML(html).addTo(map);
    });

    return () => {
      clearTimeout(debounceTimer);
      clearInterval(initPollTimer);
      clearTimeout(initPollTimeout);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 背景地図の切り替え
  // スタイル全体を作り直す(setStyle)と、森林簿・地籍・地形などのカスタムレイヤーが
  // 一旦消えて再取得されるまで不安定に見えるため、背景ラスターソースのタイルURLだけを
  // 差し替える。他のレイヤー・データには一切触れないので切り替えは即座かつ安定する。
  // 初回マウント時（ソース未作成）はスキップする。マウント時に毎回リセットするため
  // React Strict Modeでの二重マウントでも安全。
  useEffect(() => {
    if (skipNextBasemapChangeRef.current) {
      skipNextBasemapChangeRef.current = false;
      return;
    }
    const map = mapRef.current;
    const source = map?.getSource("gsi-base");
    if (!source) return;
    source.setTiles([GSI_TILES[basemap].url]);
  }, [basemap]);

  // レイヤー表示のオン/オフ
  useEffect(() => {
    refreshData();
  }, [forestVisible, landVisible, refreshData]);

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
      if (terrainEnabled) {
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
        map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      } else {
        map.setTerrain(null);
      }
    } catch (error) {
      console.error("地形設定の変更に失敗しました:", error);
    }
  }, [terrainEnabled]);

  return (
    <div className={styles.wrapper}>
      <aside className={styles.sidePane}>
        <h1 className={styles.title}>3Dマップ</h1>

        <section className={styles.section}>
          <h2>背景地図</h2>
          <select value={basemap} onChange={(event) => setBasemap(event.target.value)}>
            <option value="pale">地理院 淡色地図</option>
            <option value="std">地理院 標準地図</option>
            <option value="photo">地理院 写真</option>
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
            <p className={styles.status}>
              標高データはズームレベル12以上でのみ表示されます
            </p>
          )}
        </section>

        {status && <p className={styles.status}>{status}</p>}

        <p className={styles.hint}>
          左ドラッグ: パン / 右ドラッグ（またはCtrl+ドラッグ）: 回転・傾き /
          ホイール: ズーム / クリック: 区画情報
        </p>

        <p className={styles.attribution}>
          出典:{" "}
          <a
            href="https://maps.gsi.go.jp/development/ichiran.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            地理院タイル
          </a>
          。地形表現は標高タイルを加工して利用しています。
        </p>
      </aside>

      <div ref={mapContainerRef} className={styles.mapContainer} />
    </div>
  );
}
