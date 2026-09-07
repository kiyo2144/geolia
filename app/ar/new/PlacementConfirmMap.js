"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { haversineDistanceMeters } from "../_shared/lib/geoMath";
import styles from "./PlacementConfirmMap.module.css";

const { Map: MapLibreMap, Marker } = maplibregl;

// 設置確認用の簡易マップは2D・低ズームの平面表示のみで十分なため、
// /map画面の3D表示とは切り離し、地理院淡色地図のみを使うシンプルな構成にする。
const BASEMAP_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>';

/**
 * 「③ 地図で確認」ステップ用の簡易マップ。ユーザーの現在地と設置場所を
 * それぞれマーカーで表示し、破線で結んで距離を示す。
 */
export function PlacementConfirmMap({ userPosition, targetPosition }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const userMarkerRef = useRef(null);
  const targetMarkerRef = useRef(null);

  useEffect(() => {
    const center = userPosition ?? targetPosition ?? { lat: 35.681236, lng: 139.767125 };
    const map = new MapLibreMap({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          "gsi-pale": {
            type: "raster",
            tiles: [BASEMAP_TILE_URL],
            tileSize: 256,
            maxzoom: 18,
            attribution: GSI_ATTRIBUTION,
          },
        },
        layers: [{ id: "gsi-pale-layer", type: "raster", source: "gsi-pale" }],
      },
      center: [center.lng, center.lat],
      zoom: 17,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const tryUpdate = () => {
      if (!map.isStyleLoaded()) return;

      if (targetPosition) {
        if (!targetMarkerRef.current) {
          targetMarkerRef.current = new Marker({ color: "#e63946" }).setLngLat([
            targetPosition.lng,
            targetPosition.lat,
          ]);
          targetMarkerRef.current.addTo(map);
        } else {
          targetMarkerRef.current.setLngLat([targetPosition.lng, targetPosition.lat]);
        }
      }

      if (userPosition) {
        if (!userMarkerRef.current) {
          userMarkerRef.current = new Marker({ color: "#1e88e5" }).setLngLat([
            userPosition.lng,
            userPosition.lat,
          ]);
          userMarkerRef.current.addTo(map);
        } else {
          userMarkerRef.current.setLngLat([userPosition.lng, userPosition.lat]);
        }
      }

      if (userPosition && targetPosition) {
        const lineData = {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [userPosition.lng, userPosition.lat],
              [targetPosition.lng, targetPosition.lat],
            ],
          },
        };
        if (!map.getSource("connector-line")) {
          map.addSource("connector-line", { type: "geojson", data: lineData });
          map.addLayer({
            id: "connector-line-layer",
            type: "line",
            source: "connector-line",
            paint: { "line-color": "#4da6ff", "line-width": 2, "line-dasharray": [2, 2] },
          });
        } else {
          map.getSource("connector-line").setData(lineData);
        }

        const bounds = new maplibregl.LngLatBounds(
          [userPosition.lng, userPosition.lat],
          [userPosition.lng, userPosition.lat],
        );
        bounds.extend([targetPosition.lng, targetPosition.lat]);
        map.fitBounds(bounds, { padding: 80, maxZoom: 19 });
      }
    };

    if (map.isStyleLoaded()) {
      tryUpdate();
    } else {
      map.once("load", tryUpdate);
    }
  }, [userPosition, targetPosition]);

  const distanceLabel =
    userPosition && targetPosition
      ? `${haversineDistanceMeters(userPosition, targetPosition).toFixed(1)} m`
      : null;

  return (
    <div className={styles.wrapper}>
      <div ref={containerRef} className={styles.mapContainer} />
      {distanceLabel && <div className={styles.distanceBadge}>現在地から {distanceLabel}</div>}
    </div>
  );
}
