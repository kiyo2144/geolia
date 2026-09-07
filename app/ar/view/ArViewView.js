"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CameraBackground } from "../_shared/components/CameraBackground";
import { CompassHint } from "../_shared/components/CompassHint";
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
// コンパスのノイズだけで「視野内」判定がちらつき、実際には視野内にある配置が
// 一瞬で簡易表示に切り替わって見えなくなる（ワープして見える）事象への対策として、
// 視野内へ入る角度より出る角度を広めに取るヒステリシスを設ける。
const VIEW_ENTER_ANGLE_DEGREES = 55; // 簡易→詳細表示へ切り替わる角度のしきい値
const VIEW_EXIT_ANGLE_DEGREES = 75; // 詳細→簡易表示へ切り替わる角度のしきい値（入るときより広い）
// 至近距離では、カメラの向きが多少ずれていても実物として見えることが多いため、
// 角度によらず詳細表示の対象にする（要望により追加）。
const NEAR_DISTANCE_METERS = 30;

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

  // 各配置のローカル座標（現在地からの東西・南北・高度差）と、正面からの角度を求める
  // （純粋な計算のみ。詳細/簡易表示の振り分けはヒステリシスが必要なため別途行う）。
  const placementsRaw = useMemo(() => {
    const userPosition = geolocation.position;
    if (!userPosition) return [];

    const heading = deviceHeading ?? 0;

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

      return {
        ...placement,
        localX: east,
        localY: verticalOffset,
        localZ: -north,
        bearing,
        angleDiff: circularDiffDegrees(bearing, heading),
      };
    });
  }, [rawPlacements, geolocation.position, deviceHeading]);

  // コンパスのノイズによる「視野内」判定のちらつきを抑えるヒステリシス。
  // 一度「詳細表示」になった配置は、より広い角度（VIEW_EXIT_ANGLE_DEGREES）を
  // 超えるまで簡易表示に戻さない。「前回レンダー時の入力から変化していれば、
  // レンダー中に直接stateを更新する」というReact公式の手法
  // （https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes）
  // を使い、Effect経由の非同期な反映によるチラつきの1フレーム遅れを避ける。
  const [stickySnapshot, setStickySnapshot] = useState({ raw: null, sticky: new Set() });
  let stickyDetailIds = stickySnapshot.sticky;
  if (stickySnapshot.raw !== placementsRaw) {
    const previous = stickySnapshot.sticky;
    const next = new Set();
    for (const placement of placementsRaw) {
      const wasSticky = previous.has(placement.id);
      const isNear = placement.distance_meters <= NEAR_DISTANCE_METERS;
      const shouldEnter = isNear || placement.angleDiff <= VIEW_ENTER_ANGLE_DEGREES;
      const shouldStay = wasSticky && placement.angleDiff <= VIEW_EXIT_ANGLE_DEGREES;
      if (shouldEnter || shouldStay) next.add(placement.id);
    }
    stickyDetailIds = next;
    setStickySnapshot({ raw: placementsRaw, sticky: next });
  }

  // 視野内候補（ヒステリシス適用後）のうち、近い順に最大DETAIL_LIMIT件を
  // 「詳細表示」、残りを「簡易表示」に振り分ける（rawPlacementsは既に距離順）。
  const placementsWithGeometry = useMemo(() => {
    return placementsRaw.reduce((acc, placement) => {
      const inView = stickyDetailIds.has(placement.id);
      const tier = inView && acc.detailCount < DETAIL_LIMIT ? "detail" : "simple";
      acc.list.push({ ...placement, inView, tier });
      if (tier === "detail") acc.detailCount += 1;
      return acc;
    }, { list: [], detailCount: 0 }).list;
  }, [placementsRaw, stickyDetailIds]);

  // 現在カメラの向きから外れていて画面に映っていない配置のうち、最も近いものへの
  // 方向・距離を常時表示するヒント用のターゲット（視野内なら非表示にする）。
  const nearestOffScreenTarget = useMemo(() => {
    const candidates = placementsWithGeometry.filter((p) => !p.inView);
    if (!candidates.length) return null;
    return candidates.reduce((nearest, p) =>
      p.distance_meters < nearest.distance_meters ? p : nearest,
    );
  }, [placementsWithGeometry]);

  const getPublicUrl = useCallback(
    (storagePath, bucket = "ar-assets") =>
      supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl,
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

          {nearestOffScreenTarget && (
            <CompassHint
              userPosition={geolocation.position}
              targetPosition={nearestOffScreenTarget}
              deviceHeading={deviceHeading}
            />
          )}

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
