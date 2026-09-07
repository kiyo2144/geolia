"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CameraBackground } from "../_shared/components/CameraBackground";
import { useCameraStream } from "../_shared/hooks/useCameraStream";
import { useDeviceOrientation } from "../_shared/hooks/useDeviceOrientation";
import { useGeolocation } from "../_shared/hooks/useGeolocation";
import {
  bearingDegrees,
  circularDiffDegrees,
  haversineDistanceMeters,
  latLngToLocalMeters,
} from "../../_shared/lib/geoMath";
import { ArViewScene } from "./ArViewScene";
import { RadarMinimap } from "./RadarMinimap";
import styles from "./ArViewView.module.css";

// 要件定義 docs/requirements.md 4.2.1章の初期値
const FETCH_RADIUS_METERS = 300; // 段階1: 取得半径
const FETCH_MAX_COUNT = 100; // 段階1: 取得件数の上限
const REFETCH_DISTANCE_METERS = 15; // 現在地がこれ以上動いたら再取得する
const DETAIL_LIMIT = 8; // 段階2: 詳細表示する最大件数
const VIEW_HALF_ANGLE_DEGREES = 40; // 「カメラ視野内」とみなす、正面からの角度の半分

export function ArViewView() {
  const supabase = useMemo(() => createClient(), []);
  const geolocation = useGeolocation({ watch: true });
  const deviceOrientation = useDeviceOrientation();
  const cameraStream = useCameraStream();

  const [rawPlacements, setRawPlacements] = useState([]);
  const [fetchStatus, setFetchStatus] = useState("");
  const lastFetchPositionRef = useRef(null);

  const handleStart = async () => {
    geolocation.start();
    await Promise.all([cameraStream.start(), deviceOrientation.requestPermission()]);
  };

  // 現在地が一定距離(REFETCH_DISTANCE_METERS)以上動いたら、周辺のAR配置を再取得する
  // （要件定義4.2.1章。位置自体の平滑化はuseGeolocation内で行われている）。
  useEffect(() => {
    const position = geolocation.position;
    if (!position) return;

    const lastFetchPosition = lastFetchPositionRef.current;
    if (
      lastFetchPosition &&
      haversineDistanceMeters(lastFetchPosition, position) < REFETCH_DISTANCE_METERS
    ) {
      return;
    }

    let isCancelled = false;
    setFetchStatus("周辺のAR配置を取得中...");
    supabase
      .rpc("ar_placements_nearby", {
        center_lng: position.lng,
        center_lat: position.lat,
        radius_meters: FETCH_RADIUS_METERS,
        max_count: FETCH_MAX_COUNT,
      })
      .then(({ data, error }) => {
        if (isCancelled) return;
        if (error || !data) {
          setFetchStatus("周辺のAR配置の取得に失敗しました");
          return;
        }
        lastFetchPositionRef.current = position;
        setRawPlacements(data.features.map((feature) => feature.properties));
        setFetchStatus(`周辺のAR配置: ${data.features.length}件`);
      });

    return () => {
      isCancelled = true;
    };
  }, [geolocation.position, supabase]);

  const deviceHeading = useMemo(() => {
    if (!deviceOrientation.orientation) return null;
    const { compassHeading, alpha } = deviceOrientation.orientation;
    return compassHeading ?? alpha;
  }, [deviceOrientation.orientation]);

  // 各配置のローカル座標（現在地からの東西・南北・高度差）と、カメラ視野内かどうかを求め、
  // 視野内かつ近い順に最大DETAIL_LIMIT件を「詳細表示」、残りを「簡易表示」に振り分ける。
  const placementsWithGeometry = useMemo(() => {
    const userPosition = geolocation.position;
    if (!userPosition) return [];

    const heading = deviceHeading ?? 0;
    let detailCount = 0;

    return rawPlacements.map((placement) => {
      const { east, north } = latLngToLocalMeters(userPosition, {
        lat: placement.lat,
        lng: placement.lng,
      });
      const bearing = bearingDegrees(userPosition, { lat: placement.lat, lng: placement.lng });
      const verticalOffset =
        placement.altitude !== null &&
        placement.altitude !== undefined &&
        userPosition.altitude !== null &&
        userPosition.altitude !== undefined
          ? placement.altitude - userPosition.altitude
          : 0;
      const inView = circularDiffDegrees(bearing, heading) <= VIEW_HALF_ANGLE_DEGREES;

      let tier = "simple";
      if (inView && detailCount < DETAIL_LIMIT) {
        tier = "detail";
        detailCount += 1;
      }

      return {
        ...placement,
        localX: east,
        localY: verticalOffset,
        localZ: -north,
        bearing,
        inView,
        tier,
      };
    });
  }, [rawPlacements, geolocation.position, deviceHeading]);

  const getPublicUrl = useCallback(
    (storagePath) => supabase.storage.from("ar-assets").getPublicUrl(storagePath).data.publicUrl,
    [supabase],
  );

  return (
    <div className={styles.wrapper}>
      {/* isActiveに関わらず常にマウントしておく。カメラ開始時にvideo要素が
          まだ存在しないとストリームを紐付けられず、映像が真っ黒になるため。 */}
      <CameraBackground videoRef={cameraStream.videoRef} />

      {cameraStream.isActive && (
        <>
          <ArViewScene
            orientation={deviceOrientation.orientation}
            placements={placementsWithGeometry}
            getPublicUrl={getPublicUrl}
          />

          <RadarMinimap
            heading={deviceHeading ?? 0}
            placements={placementsWithGeometry}
            radiusMeters={FETCH_RADIUS_METERS}
          />

          <div className={styles.statusBar}>
            {fetchStatus && <p className={styles.status}>{fetchStatus}</p>}
            {geolocation.error && (
              <p className={styles.error}>位置情報エラー: {geolocation.error.message}</p>
            )}
          </div>
        </>
      )}

      {!cameraStream.isActive && (
        <div className={styles.panelOverlay}>
          <p>
            カメラ・位置情報・端末の向きへのアクセスを許可すると、現在地周辺に設置された
            AR配置がまとめて表示されます。（iOSでは許可ダイアログが表示されます）
          </p>
          <button type="button" onClick={handleStart}>
            ARを開始
          </button>
          {cameraStream.error && (
            <p className={styles.error}>カメラエラー: {cameraStream.error.message}</p>
          )}
          {deviceOrientation.permissionState === "denied" && (
            <p className={styles.error}>
              端末の向きへのアクセスが拒否されました。設定から許可してください。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
