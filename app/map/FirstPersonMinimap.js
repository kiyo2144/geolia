"use client";

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import styles from "./FirstPersonMinimap.module.css";

// CORS制限のため、OSMタイルは同一オリジンの中継API（mapMeshBuilders.jsと同じ仕組み）経由で取得する
const OSM_TILE_URL_TEMPLATE = "/api/basemap-tile/osm/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";
const DEFAULT_ZOOM = 16;
const MIN_ZOOM = 10;
const MAX_ZOOM = 19;
// プレイヤーの位置・向きは一人称視点側で毎フレーム更新されるが、
// 地図ライブラリの更新は毎フレーム行うとコストが高いため間引く
const PLAYER_UPDATE_INTERVAL_MS = 150;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function headingDegFromYaw(yaw) {
  const deg = ((-yaw * 180) / Math.PI) % 360;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * 実機（スマートフォン等）のコンパスセンサーから向いている方角を取得する。
 * iOS 13+はユーザー操作による明示的な許可が必要なため、その場合はボタンで許可を求める。
 * 非対応環境（PCなど）では何も起きない。
 */
function useDeviceHeading() {
  const [heading, setHeading] = useState(null);
  // 許可が必要かどうかは端末固有の静的な性質なので、初回のみ判定して以後は固定値として扱う
  const [needsPermission] = useState(
    () => typeof window !== "undefined" && typeof window.DeviceOrientationEvent?.requestPermission === "function",
  );
  const handlerRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.DeviceOrientationEvent || needsPermission) return undefined;

    const handleOrientation = (event) => {
      const compassHeading =
        typeof event.webkitCompassHeading === "number"
          ? event.webkitCompassHeading
          : event.absolute && typeof event.alpha === "number"
            ? 360 - event.alpha
            : null;
      if (compassHeading != null) setHeading(compassHeading);
    };
    handlerRef.current = handleOrientation;

    window.addEventListener("deviceorientationabsolute", handleOrientation);
    window.addEventListener("deviceorientation", handleOrientation);
    return () => {
      window.removeEventListener("deviceorientationabsolute", handleOrientation);
      window.removeEventListener("deviceorientation", handleOrientation);
    };
  }, [needsPermission]);

  const requestPermission = async () => {
    if (typeof window.DeviceOrientationEvent?.requestPermission !== "function") return;
    try {
      const result = await window.DeviceOrientationEvent.requestPermission();
      if (result === "granted" && handlerRef.current) {
        setNeedsPermission(false);
        window.addEventListener("deviceorientation", handlerRef.current);
      }
    } catch {
      // 端末が非対応、またはユーザーが許可しなかった場合は何もしない
    }
  };

  return { heading, needsPermission, requestPermission };
}

/**
 * 一人称視点画面の右上に表示する、OpenStreetMapベースの平面サブマップ。
 * 現在地・向きの表示に加え、スクロール／バーでの拡大縮小、ボタンによる表示サイズの
 * 切り替え（デフォルト／約4倍）、クリックによる瞬間移動、方角アイコン
 * （＋対応端末ではコンパスセンサーの向き）に対応する。
 */
export function FirstPersonMinimap({
  origin,
  project,
  placements,
  boundsMeters,
  playerStateRef,
  teleportRequestRef,
  placementPickActive,
  onPlacementPick,
  pickedLngLat,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const playerMarkerRef = useRef(null);
  const pickedMarkerRef = useRef(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [isEnlarged, setIsEnlarged] = useState(false);
  const { heading, needsPermission, requestPermission } = useDeviceHeading();

  // クリック時のハンドラは初回マウント時にのみ登録するため、最新の値をrefで参照する
  const placementPickActiveRef = useRef(placementPickActive);
  useEffect(() => {
    placementPickActiveRef.current = placementPickActive;
  }, [placementPickActive]);
  const onPlacementPickRef = useRef(onPlacementPick);
  useEffect(() => {
    onPlacementPickRef.current = onPlacementPick;
  }, [onPlacementPick]);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [`${window.location.origin}${OSM_TILE_URL_TEMPLATE}`],
            tileSize: 256,
            maxzoom: MAX_ZOOM,
            attribution: OSM_ATTRIBUTION,
          },
        },
        layers: [{ id: "osm-layer", type: "raster", source: "osm" }],
      },
      center: [origin.lng, origin.lat],
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    mapRef.current = map;

    const markerEl = document.createElement("div");
    markerEl.className = styles.playerMarker;
    const marker = new maplibregl.Marker({ element: markerEl, rotationAlignment: "map" })
      .setLngLat([origin.lng, origin.lat])
      .addTo(map);
    playerMarkerRef.current = marker;

    const handleZoom = () => setZoom(map.getZoom());
    map.on("zoom", handleZoom);

    const handleClick = (event) => {
      const { lng, lat } = event.lngLat;
      if (placementPickActiveRef.current) {
        onPlacementPickRef.current?.({ lng, lat });
        return;
      }
      const { x, y: northMeters } = project(lng, lat);
      teleportRequestRef.current = {
        x: clamp(x, -boundsMeters, boundsMeters),
        z: clamp(-northMeters, -boundsMeters, boundsMeters),
      };
    };
    map.on("click", handleClick);

    return () => {
      map.off("zoom", handleZoom);
      map.off("click", handleClick);
      marker.remove();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 周辺AR配置マーカー（配置は読み込み時に確定するため、変化した場合のみ張り直す）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const markers = placements
      .filter((placement) => placement.lng != null && placement.lat != null)
      .map((placement) => {
        const el = document.createElement("div");
        el.className = styles.placementMarker;
        return new maplibregl.Marker({ element: el }).setLngLat([placement.lng, placement.lat]).addTo(map);
      });
    return () => {
      markers.forEach((marker) => marker.remove());
    };
  }, [placements]);

  // AR設置でサブマップクリックにより選んだ候補地点のマーカー
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    if (!pickedLngLat) {
      pickedMarkerRef.current?.remove();
      pickedMarkerRef.current = null;
      return undefined;
    }
    if (!pickedMarkerRef.current) {
      const el = document.createElement("div");
      el.className = styles.pickedMarker;
      pickedMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([
        pickedLngLat.lng,
        pickedLngLat.lat,
      ]);
      pickedMarkerRef.current.addTo(map);
    } else {
      pickedMarkerRef.current.setLngLat([pickedLngLat.lng, pickedLngLat.lat]);
    }
  }, [pickedLngLat]);

  // 現在地・向きの表示を定期的に更新する（毎フレームではなく間引いて負荷を抑える）
  useEffect(() => {
    const interval = setInterval(() => {
      const marker = playerMarkerRef.current;
      if (!marker) return;
      const { x, z, yaw } = playerStateRef.current;
      const { lng, lat } = project.unproject(x, -z);
      marker.setLngLat([lng, lat]);
      marker.setRotation(headingDegFromYaw(yaw));
    }, PLAYER_UPDATE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [project, playerStateRef]);

  // サイズ切り替え（デフォルト／約4倍）でパネルのCSSサイズが変わった際に、
  // 地図の描画サイズを追従させる
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.wrapper}>
      <div
        ref={containerRef}
        className={`${styles.mapContainer} ${isEnlarged ? styles.mapContainerLarge : ""}`}
      />

      <div className={styles.compassBadge}>
        <span>N</span>
        {heading != null && (
          <div className={styles.compassNeedle} style={{ transform: `translateX(-50%) rotate(${-heading}deg)` }} />
        )}
      </div>

      <button
        type="button"
        className={styles.sizeToggleButton}
        onClick={() => setIsEnlarged((current) => !current)}
      >
        {isEnlarged ? "縮小" : "拡大"}
      </button>

      {needsPermission && (
        <button type="button" className={styles.compassPermissionButton} onClick={requestPermission}>
          方角センサーを有効にする
        </button>
      )}

      <input
        type="range"
        className={styles.zoomSlider}
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={0.5}
        value={zoom}
        onChange={(event) => mapRef.current?.setZoom(Number(event.target.value))}
        aria-label="サブマップの拡大縮小"
      />

      <p className={styles.hintText}>
        {placementPickActive ? "クリックでAR設置位置を選択" : "クリックでその場所へ移動"}
      </p>
    </div>
  );
}
