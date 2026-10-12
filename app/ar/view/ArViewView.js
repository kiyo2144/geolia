"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CameraBackground } from "../_shared/components/CameraBackground";
import { CompassHint } from "../_shared/components/CompassHint";
import { useCameraStream } from "../_shared/hooks/useCameraStream";
import { useDeviceOrientation } from "../_shared/hooks/useDeviceOrientation";
import { useArViewAdjustGestures } from "../_shared/hooks/useArViewAdjustGestures";
import { useGeolocation } from "../_shared/hooks/useGeolocation";
import {
  bearingDegrees,
  circularDiffDegrees,
  haversineDistanceMeters,
  latLngToLocalMeters,
} from "../../_shared/lib/geoMath";
import { createElevationSampler } from "../../map/mapMeshBuilders";
import {
  getEffectiveAltitude,
  isAltitudeUnreliable as checkAltitudeUnreliable,
} from "../_shared/lib/altitudeReliability";
import { ArViewScene } from "./ArViewScene";
import { RadarMinimap } from "./RadarMinimap";
import styles from "./ArViewView.module.css";

// 位置追従・GPS高度の原因切り分け用に追加したデバッグ表示の一時的な表示切り替え。
// 調査が必要になったらtrueに戻す。
const SHOW_DEBUG_INFO = false;

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
// 現在地の平滑化係数（EMA）。useGeolocationの既定値(0.25)は地図上のマーカー表示など
// 向けの穏やかな設定だが、AR閲覧では「歩いた分だけAR配置が近づいて見える」ことが
// 体験上重要なため、既定よりも追従を速くする（実機検証: 既定値だと徒歩中の平滑化の
// 遅れが数m相当になり、AR配置が自分に付いてくるように見えてしまっていた）。
const AR_VIEW_POSITION_EMA_ALPHA = 0.6;

// 調整モード（画面を開いている間だけの見た目上の位置・角度の補正）の操作量
const ADJUST_ROTATE_RADIANS_PER_PIXEL = 0.012; // 1本指の横ドラッグ（AR設置画面と同じ）
const ADJUST_MOVE_METERS_PER_PIXEL = 0.004; // 2本指ドラッグ
const ADJUST_ROTATE_STEP_RADIANS = Math.PI / 12; // ボタン1回あたり15度
const ADJUST_MOVE_STEP_METERS = 0.5; // ボタン1回あたり
const ADJUST_HEIGHT_STEP_METERS = 0.2; // ボタン1回あたり
const ZERO_INDIVIDUAL_ADJUSTMENT = { east: 0, north: 0, up: 0, yaw: 0 };
const ZERO_GLOBAL_ADJUSTMENT = { east: 0, north: 0, yaw: 0 };

// 自己位置の標高タイルサンプラーを取得する範囲（度）。AR設置画面と違い歩き回るため、
// 少し動くたびに取得し直さずに済むよう広めに取っている（約1km四方）。
const ELEVATION_SAMPLER_MARGIN_DEGREES = 0.01;
// 現在地がサンプリング範囲の端に近づく前に、サンプラーを取得し直す目安の距離。
const ELEVATION_REFRESH_DISTANCE_METERS = 500;

export function ArViewView() {
  const supabase = useMemo(() => createClient(), []);
  const geolocation = useGeolocation({ watch: true, emaAlpha: AR_VIEW_POSITION_EMA_ALPHA });
  const deviceOrientation = useDeviceOrientation();
  const cameraStream = useCameraStream();

  const [rawPlacements, setRawPlacements] = useState([]);
  const [fetchStatus, setFetchStatus] = useState("");
  const lastFetchPositionRef = useRef(null);

  // 自己位置でのGPS高度の信頼性判定用。標高タイルをサンプリングして、
  // 現在地の地面の高さ(groundElevationAtUser)を求めておく。
  const [groundElevationAtUser, setGroundElevationAtUser] = useState(null);
  const elevationSamplerRef = useRef(null);
  const lastElevationSamplePositionRef = useRef(null);

  useEffect(() => {
    const position = geolocation.position;
    if (!position) return undefined;

    const lastSamplePosition = lastElevationSamplePositionRef.current;
    if (
      elevationSamplerRef.current &&
      lastSamplePosition &&
      haversineDistanceMeters(lastSamplePosition, position) < ELEVATION_REFRESH_DISTANCE_METERS
    ) {
      setGroundElevationAtUser(elevationSamplerRef.current(position.lng, position.lat));
      return undefined;
    }

    let isCancelled = false;
    const margin = ELEVATION_SAMPLER_MARGIN_DEGREES;
    createElevationSampler({
      minLng: position.lng - margin,
      maxLng: position.lng + margin,
      minLat: position.lat - margin,
      maxLat: position.lat + margin,
    })
      .then((sampler) => {
        if (isCancelled) return;
        elevationSamplerRef.current = sampler;
        lastElevationSamplePositionRef.current = position;
        setGroundElevationAtUser(sampler(position.lng, position.lat));
      })
      .catch(() => {
        // 標高タイルが取得できなくてもAR閲覧自体は継続できるようにする(高度補正のみ諦める)
      });

    return () => {
      isCancelled = true;
    };
  }, [geolocation.position]);

  // 自己位置のGPS高度が信頼できない場合、代わりに使う高度
  // （標高タイルの地面 + 人がスマホを構える高さの目安）。
  const effectiveUserAltitude = useMemo(
    () => getEffectiveAltitude(geolocation.position?.altitude, groundElevationAtUser),
    [geolocation.position, groundElevationAtUser],
  );
  const isUserAltitudeUnreliable = checkAltitudeUnreliable(
    geolocation.position?.altitude,
    groundElevationAtUser,
  );

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
      // 高度差は自己位置の生のGPS高度ではなく、信頼できない場合に補正した
      // effectiveUserAltitudeを基準にする（AR設置画面と同じ考え方）。
      const verticalOffset =
        placement.altitude !== null &&
        placement.altitude !== undefined &&
        effectiveUserAltitude !== null &&
        effectiveUserAltitude !== undefined
          ? placement.altitude - effectiveUserAltitude
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
  }, [rawPlacements, geolocation.position, deviceHeading, effectiveUserAltitude]);

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

  // --- 調整モード: 画面を開いている間だけの、見た目上の位置・角度の補正 ---
  // DBには保存せず、画面を閉じる・リロードすると破棄される（他のユーザーにも影響しない）。
  // 値は「現在地を原点としたワールド固定」の東西・南北・高さ・水平回転で持つ。
  const [isAdjustMode, setIsAdjustMode] = useState(false);
  // trueの間は、選択中の個別コンテンツではなく全コンテンツへまとめて適用する
  const [applyToAll, setApplyToAll] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [individualAdjustments, setIndividualAdjustments] = useState({});
  const [globalAdjustment, setGlobalAdjustment] = useState(ZERO_GLOBAL_ADJUSTMENT);
  const pickRequestRef = useRef(null);
  const deviceHeadingRef = useRef(null);
  useEffect(() => {
    deviceHeadingRef.current = deviceHeading;
  }, [deviceHeading]);

  const adjustments = useMemo(
    () => ({ byId: individualAdjustments, global: globalAdjustment }),
    [individualAdjustments, globalAdjustment],
  );

  const updateIndividual = useCallback((id, updater) => {
    setIndividualAdjustments((prev) => ({
      ...prev,
      [id]: updater(prev[id] ?? ZERO_INDIVIDUAL_ADJUSTMENT),
    }));
  }, []);

  const rotateBy = useCallback(
    (radians) => {
      if (applyToAll) {
        setGlobalAdjustment((prev) => ({ ...prev, yaw: prev.yaw + radians }));
      } else if (selectedId) {
        updateIndividual(selectedId, (a) => ({ ...a, yaw: a.yaw + radians }));
      }
    },
    [applyToAll, selectedId, updateIndividual],
  );

  // 画面の向き（コンパス方位）を基準に、前後(forward)・左右(right)へメートル単位で動かす
  const moveBy = useCallback(
    (forwardMeters, rightMeters) => {
      const headingRadians = ((deviceHeadingRef.current ?? 0) * Math.PI) / 180;
      const east = Math.sin(headingRadians) * forwardMeters + Math.cos(headingRadians) * rightMeters;
      const north = Math.cos(headingRadians) * forwardMeters - Math.sin(headingRadians) * rightMeters;
      if (applyToAll) {
        setGlobalAdjustment((prev) => ({ ...prev, east: prev.east + east, north: prev.north + north }));
      } else if (selectedId) {
        updateIndividual(selectedId, (a) => ({ ...a, east: a.east + east, north: a.north + north }));
      }
    },
    [applyToAll, selectedId, updateIndividual],
  );

  // 高さは個別のコンテンツにのみ適用する（今の表示高さからの増減）
  const changeHeightBy = useCallback(
    (meters) => {
      if (applyToAll || !selectedId) return;
      updateIndividual(selectedId, (a) => ({ ...a, up: a.up + meters }));
    },
    [applyToAll, selectedId, updateIndividual],
  );

  const resetCurrentTarget = useCallback(() => {
    if (applyToAll) {
      setGlobalAdjustment(ZERO_GLOBAL_ADJUSTMENT);
    } else if (selectedId) {
      setIndividualAdjustments((prev) => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
    }
  }, [applyToAll, selectedId]);

  const resetAllAdjustments = useCallback(() => {
    setIndividualAdjustments({});
    setGlobalAdjustment(ZERO_GLOBAL_ADJUSTMENT);
  }, []);

  const adjustSurfaceRef = useArViewAdjustGestures({
    enabled: isAdjustMode,
    onTap: (x, y) => {
      pickRequestRef.current = { x, y };
    },
    onRotateByDelta: (deltaPixels) => rotateBy(deltaPixels * ADJUST_ROTATE_RADIANS_PER_PIXEL),
    onMoveByDelta: (deltaX, deltaY) =>
      moveBy(-deltaY * ADJUST_MOVE_METERS_PER_PIXEL, deltaX * ADJUST_MOVE_METERS_PER_PIXEL),
  });

  const detailPlacements = placementsWithGeometry.filter((p) => p.tier === "detail");
  const selectedPlacement = placementsWithGeometry.find((p) => p.id === selectedId) ?? null;
  const currentAdjustment = applyToAll
    ? { ...globalAdjustment, up: null }
    : selectedId
      ? (individualAdjustments[selectedId] ?? ZERO_INDIVIDUAL_ADJUSTMENT)
      : null;
  const hasAdjustTarget = applyToAll || !!selectedId;

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
            showDebugInfo={SHOW_DEBUG_INFO}
            adjustments={adjustments}
            selectedId={selectedId}
            isAdjustMode={isAdjustMode}
            pickRequestRef={pickRequestRef}
            onPick={setSelectedId}
          />

          {isAdjustMode && <div ref={adjustSurfaceRef} className={styles.adjustSurface} />}

          <button
            type="button"
            className={isAdjustMode ? styles.adjustToggleActive : styles.adjustToggle}
            onClick={() => setIsAdjustMode((current) => !current)}
          >
            調整モード: {isAdjustMode ? "ON" : "OFF"}
          </button>

          {isAdjustMode && (
            <div className={styles.adjustPanel}>
              <p className={styles.adjustPanelHint}>
                画面を開いている間だけの見た目の補正です（保存されません）。
                タップで選択 ・ 1本指スワイプで回転 ・ 2本指ドラッグで移動（PCはShift+ドラッグ）
              </p>

              <div className={styles.adjustTargetList}>
                {detailPlacements.length === 0 && (
                  <span className={styles.adjustPanelHint}>調整できる表示中のコンテンツがありません</span>
                )}
                {detailPlacements.map((placement) => (
                  <button
                    key={placement.id}
                    type="button"
                    className={
                      !applyToAll && placement.id === selectedId
                        ? styles.adjustTargetButtonActive
                        : styles.adjustTargetButton
                    }
                    onClick={() => {
                      setApplyToAll(false);
                      setSelectedId(placement.id);
                    }}
                  >
                    {placement.label || "(名前なし)"}
                  </button>
                ))}
              </div>

              <button
                type="button"
                className={applyToAll ? styles.adjustTargetButtonActive : styles.adjustTargetButton}
                onClick={() => setApplyToAll((current) => !current)}
              >
                全体に適用: {applyToAll ? "ON" : "OFF"}
              </button>

              <p className={styles.adjustPanelHint}>
                操作対象:{" "}
                {applyToAll
                  ? "全てのコンテンツ（現在地を中心にまとめて回転・移動）"
                  : selectedPlacement
                    ? selectedPlacement.label
                    : "未選択（コンテンツをタップするか、上の一覧から選択）"}
              </p>

              <div className={styles.adjustGrid}>
                <span>回転</span>
                <div className={styles.adjustButtons}>
                  <button type="button" disabled={!hasAdjustTarget} onClick={() => rotateBy(-ADJUST_ROTATE_STEP_RADIANS)}>
                    ◀
                  </button>
                  <button type="button" disabled={!hasAdjustTarget} onClick={() => rotateBy(ADJUST_ROTATE_STEP_RADIANS)}>
                    ▶
                  </button>
                </div>

                <span>位置(前後)</span>
                <div className={styles.adjustButtons}>
                  <button type="button" disabled={!hasAdjustTarget} onClick={() => moveBy(-ADJUST_MOVE_STEP_METERS, 0)}>
                    手前へ
                  </button>
                  <button type="button" disabled={!hasAdjustTarget} onClick={() => moveBy(ADJUST_MOVE_STEP_METERS, 0)}>
                    奥へ
                  </button>
                </div>

                <span>位置(左右)</span>
                <div className={styles.adjustButtons}>
                  <button type="button" disabled={!hasAdjustTarget} onClick={() => moveBy(0, -ADJUST_MOVE_STEP_METERS)}>
                    左へ
                  </button>
                  <button type="button" disabled={!hasAdjustTarget} onClick={() => moveBy(0, ADJUST_MOVE_STEP_METERS)}>
                    右へ
                  </button>
                </div>

                <span>高さ</span>
                <div className={styles.adjustButtons}>
                  <button
                    type="button"
                    disabled={applyToAll || !selectedId}
                    onClick={() => changeHeightBy(-ADJUST_HEIGHT_STEP_METERS)}
                  >
                    －
                  </button>
                  <button
                    type="button"
                    disabled={applyToAll || !selectedId}
                    onClick={() => changeHeightBy(ADJUST_HEIGHT_STEP_METERS)}
                  >
                    ＋
                  </button>
                </div>
              </div>

              {currentAdjustment && (
                <p className={styles.adjustPanelHint}>
                  現在の補正: 東西 {currentAdjustment.east.toFixed(1)}m ・ 南北 {currentAdjustment.north.toFixed(1)}m
                  {currentAdjustment.up !== null && ` ・ 高さ ${currentAdjustment.up.toFixed(1)}m`}
                  {" ・ 回転 "}
                  {Math.round((currentAdjustment.yaw * 180) / Math.PI)}度
                </p>
              )}

              <div className={styles.adjustButtons}>
                <button type="button" disabled={!hasAdjustTarget} onClick={resetCurrentTarget}>
                  {applyToAll ? "全体の補正をリセット" : "選択中をリセット"}
                </button>
                <button type="button" onClick={resetAllAdjustments}>
                  すべてリセット
                </button>
              </div>
            </div>
          )}

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
            {/* 位置追従の調査用。移動しても現在地・精度がどう変化するかと、生fixが
                精度ゲート・外れ値検知のどちらでどれだけ棄却されているかを確認するための
                一時的な表示（原因切り分けが済んだら削除する）。 */}
            {SHOW_DEBUG_INFO && geolocation.position && (
              <p className={styles.status}>
                緯度 {geolocation.position.lat.toFixed(6)}　経度 {geolocation.position.lng.toFixed(6)}
                　精度 約{Math.round(geolocation.position.accuracy)}m
              </p>
            )}

            {isUserAltitudeUnreliable && (
              <p className={styles.error}>
                GPSの高度精度が低いため、AR配置の高さは目安（3Dマップの標高 + 約1m）で計算しています
              </p>
            )}

            {deviceOrientation.permissionState === "denied" && (
              <p className={styles.error}>
                端末の向きへのアクセスが拒否されているため、周辺のAR配置が正しい方向に表示されません。
                設定 &gt; Safari &gt; 「モーションと画面の向きへのアクセス」を確認してください。
              </p>
            )}

            {/* 自己位置のGPS高度の信頼性判定のデバッグ表示（原因切り分けが済んだら削除する） */}
            {SHOW_DEBUG_INFO && geolocation.position && (
              <p className={styles.status}>
                生の高度 約{geolocation.position.altitude?.toFixed(2) ?? "?"}m　標高タイル 約
                {groundElevationAtUser === null ? "?" : groundElevationAtUser.toFixed(2)}m　補正後高度 約
                {effectiveUserAltitude === null ? "?" : effectiveUserAltitude.toFixed(2)}m　信頼性低判定:{" "}
                {isUserAltitudeUnreliable ? "YES" : "no"}
              </p>
            )}

            {SHOW_DEBUG_INFO && (
              <p className={styles.status}>
                生fix {geolocation.debugInfo.rawFixCount}件　採用 {geolocation.debugInfo.acceptedCount}件
                　精度棄却 {geolocation.debugInfo.accuracyRejectedCount}件　外れ値棄却{" "}
                {geolocation.debugInfo.outlierRejectedCount}件
                {geolocation.debugInfo.lastRawAccuracy !== null &&
                  `　直近の生精度 約${Math.round(geolocation.debugInfo.lastRawAccuracy)}m`}
                {geolocation.debugInfo.lastRejectReason &&
                  `　直近の棄却理由: ${geolocation.debugInfo.lastRejectReason}`}
              </p>
            )}
            {SHOW_DEBUG_INFO && geolocation.debugInfo.lastRawLat !== null && (
              <p className={styles.status}>
                生の緯度 {geolocation.debugInfo.lastRawLat.toFixed(6)}　生の経度{" "}
                {geolocation.debugInfo.lastRawLng.toFixed(6)}　直前と同座標{" "}
                {geolocation.debugInfo.sameAsPreviousRawCount}回
              </p>
            )}

            {/* 配置が0件表示になる不具合の原因切り分け用（原因切り分けが済んだら削除する） */}
            {SHOW_DEBUG_INFO && (
              <p className={styles.status}>
                取得 {rawPlacements.length}件　detail{" "}
                {placementsWithGeometry.filter((p) => p.tier === "detail").length}件　simple{" "}
                {placementsWithGeometry.filter((p) => p.tier === "simple").length}件　視野内候補{" "}
                {stickyDetailIds.size}件　端末の向き{" "}
                {deviceHeading === null ? "取得できていません" : `約${Math.round(deviceHeading)}度`}
              </p>
            )}
            {SHOW_DEBUG_INFO && placementsRaw[0] && (
              <p className={styles.status}>
                最も近い配置: {placementsRaw[0].label}　距離 約
                {Math.round(placementsRaw[0].distance_meters)}m　方位角 約
                {Math.round(placementsRaw[0].bearing)}度　正面との角度差 約
                {Math.round(placementsRaw[0].angleDiff)}度　高度差 約
                {placementsRaw[0].localY.toFixed(1)}m
              </p>
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
