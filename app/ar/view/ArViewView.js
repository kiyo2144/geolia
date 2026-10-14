"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CameraBackground } from "../_shared/components/CameraBackground";
import { CompassHint } from "../_shared/components/CompassHint";
import { useCameraStream } from "../_shared/hooks/useCameraStream";
import { useDeviceOrientation } from "../_shared/hooks/useDeviceOrientation";
import {
  HOLD_ARM_MS,
  HOLD_RESET_MS,
  useArViewAdjustGestures,
} from "../_shared/hooks/useArViewAdjustGestures";
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
// HTML（ライブ表示）は、1件ごとにiframe（WebGLを使うものはGPU描画も）が動くため端末への負荷が
// 非常に大きい。iPhoneで複数を同時に動かすとメモリ・GPU負荷でページごと強制終了される
// （実機で確認）ため、同時に動かす数を絞る（近い順）。なお、動かす対象を視野角で絞ると、
// 配置した場所のすぐそばではGPS誤差で方位がずれて視野外と判定され、HTMLが出なくなる
// （実機で確認）ため、他のコンテンツと同様に「近さ」で判定する。負荷は、iframe内の描画
// 解像度の固定（lib/htmlSandbox.js）と、この件数の上限で抑える。
const MAX_LIVE_HTML_COUNT = 2;
// 現在地の平滑化係数（EMA）。useGeolocationの既定値(0.25)は地図上のマーカー表示など
// 向けの穏やかな設定だが、AR閲覧では「歩いた分だけAR配置が近づいて見える」ことが
// 体験上重要なため、既定よりも追従を速くする（実機検証: 既定値だと徒歩中の平滑化の
// 遅れが数m相当になり、AR配置が自分に付いてくるように見えてしまっていた）。
const AR_VIEW_POSITION_EMA_ALPHA = 0.6;

// 調整モード（画面を開いている間だけの見た目上の位置・角度・大きさの補正）の操作量
const ADJUST_ROTATE_RADIANS_PER_PIXEL = 0.012; // 1本指の横ドラッグ（AR設置画面と同じ）
const ADJUST_MOVE_METERS_PER_PIXEL = 0.004; // 2本指ドラッグ
const ADJUST_PITCH_RADIANS_PER_PIXEL = 0.008; // 1本指の縦ドラッグ（縦回転）
const ADJUST_MAX_PITCH_RADIANS = Math.PI / 2; // 縦回転の上限（±90度）
const ADJUST_HEIGHT_METERS_PER_PIXEL = 0.01; // 長押し→上下ドラッグ（高さ）
const UNDO_RESET_VISIBLE_MS = 6000; // リセット直後に「元に戻す」を出しておく時間
const HINT_VISIBLE_MS = 7000; // 操作ヒントを自動で消すまでの時間
const ADJUST_ROTATE_STEP_RADIANS = Math.PI / 12; // ボタン1回あたり15度
const ADJUST_MOVE_STEP_METERS = 0.5; // ボタン1回あたり
const ADJUST_HEIGHT_STEP_METERS = 0.2; // ボタン1回あたり
const ADJUST_SCALE_STEP_RATIO = 1.15; // ボタン1回あたり
// 個別の拡大率（元の大きさに対する倍率）の範囲
const ADJUST_MIN_SCALE = 0.1;
const ADJUST_MAX_SCALE = 20;
const ZERO_INDIVIDUAL_ADJUSTMENT = { east: 0, north: 0, up: 0, yaw: 0, pitch: 0, scale: 1 };
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
  // 動作が不安定な端末向けの緊急回避用。/ar/view?html=off でHTMLのライブ表示を無効にし、
  // HTMLの配置も簡易表示（ラベル）にする。
  const [isLiveHtmlDisabled] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("html") === "off",
  );
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
      const isHtml = placement.asset_type === "html";
      // HTMLは同時にライブ表示できる件数を絞る（近い順なので、近いものが優先される）
      // 同じ名前・同じ位置に重複して登録されたHTMLは、重なって見えるだけなので1件だけ動かす
      const htmlKey = isHtml
        ? `${placement.label}|${placement.lat.toFixed(5)}|${placement.lng.toFixed(5)}`
        : null;
      const canShowDetail =
        !isHtml ||
        (!isLiveHtmlDisabled && acc.htmlCount < MAX_LIVE_HTML_COUNT && !acc.htmlKeys.has(htmlKey));
      const tier = inView && acc.detailCount < DETAIL_LIMIT && canShowDetail ? "detail" : "simple";
      acc.list.push({ ...placement, inView, tier });
      if (tier === "detail") {
        acc.detailCount += 1;
        if (isHtml) {
          acc.htmlCount += 1;
          acc.htmlKeys.add(htmlKey);
        }
      }
      return acc;
    }, { list: [], detailCount: 0, htmlCount: 0, htmlKeys: new Set() }).list;
  }, [placementsRaw, stickyDetailIds, isLiveHtmlDisabled]);

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

  // --- 調整モード: 画面を開いている間だけの、見た目上の位置・角度・大きさの補正 ---
  // DBには保存せず、画面を閉じる・リロードすると破棄される（他のユーザーにも影響しない）。
  // 値は「現在地を原点としたワールド固定」の東西・南北・高さ・水平回転・拡大率で持つ。
  // 操作対象は「タップで選んだ1件（個別）」で、何も選んでいない間は「全体」を動かす。
  // 調整モードは、画面を開くたびにONで始める（OFFにしても保存しない）。
  const [isAdjustMode, setIsAdjustMode] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [isFineAdjustOpen, setIsFineAdjustOpen] = useState(false);
  const [individualAdjustments, setIndividualAdjustments] = useState({});
  const [globalAdjustment, setGlobalAdjustment] = useState(ZERO_GLOBAL_ADJUSTMENT);
  // 「正面に呼ぶ」を押す前の補正値（「元の位置に戻す」で復元する）
  const [frontSavedAdjustments, setFrontSavedAdjustments] = useState({});
  const pickRequestRef = useRef(null);
  const bringRequestRef = useRef(null);
  const reticleRef = useRef(null);
  const deviceHeadingRef = useRef(null);
  const individualAdjustmentsRef = useRef({});
  const globalAdjustmentRef = useRef(ZERO_GLOBAL_ADJUSTMENT);
  const frontSavedAdjustmentsRef = useRef({});
  // 長押しの状態（null | "armed"=高さ調整の待機/リセットのカウント中 | "height"=高さを調整中）
  const [holdPhase, setHoldPhase] = useState(null);
  // 直前のリセット前の補正値。リセット直後だけ「元に戻す」で復元できる。
  const [undoSnapshot, setUndoSnapshot] = useState(null);
  // 操作ヒントを表示し終えたか（未選択用・選択中用でそれぞれ1回ずつ）
  const [doneHints, setDoneHints] = useState({ none: false, selected: false });
  useEffect(() => {
    deviceHeadingRef.current = deviceHeading;
  }, [deviceHeading]);
  useEffect(() => {
    individualAdjustmentsRef.current = individualAdjustments;
  }, [individualAdjustments]);
  useEffect(() => {
    globalAdjustmentRef.current = globalAdjustment;
  }, [globalAdjustment]);
  useEffect(() => {
    frontSavedAdjustmentsRef.current = frontSavedAdjustments;
  }, [frontSavedAdjustments]);

  useEffect(() => {
    if (!undoSnapshot) return undefined;
    const timer = setTimeout(() => setUndoSnapshot(null), UNDO_RESET_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [undoSnapshot]);

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
      if (selectedId) {
        updateIndividual(selectedId, (a) => ({ ...a, yaw: a.yaw + radians }));
      } else {
        setGlobalAdjustment((prev) => ({ ...prev, yaw: prev.yaw + radians }));
      }
    },
    [selectedId, updateIndividual],
  );

  // 画面の向き（コンパス方位）を基準に、前後(forward)・左右(right)へメートル単位で動かす
  const moveBy = useCallback(
    (forwardMeters, rightMeters) => {
      const headingRadians = ((deviceHeadingRef.current ?? 0) * Math.PI) / 180;
      const east = Math.sin(headingRadians) * forwardMeters + Math.cos(headingRadians) * rightMeters;
      const north = Math.cos(headingRadians) * forwardMeters - Math.sin(headingRadians) * rightMeters;
      if (selectedId) {
        updateIndividual(selectedId, (a) => ({ ...a, east: a.east + east, north: a.north + north }));
      } else {
        setGlobalAdjustment((prev) => ({ ...prev, east: prev.east + east, north: prev.north + north }));
      }
    },
    [selectedId, updateIndividual],
  );

  // 縦回転・高さ・大きさは個別のコンテンツにのみ適用する（今の表示からの増減・倍率）
  const pitchBy = useCallback(
    (radians) => {
      if (!selectedId) return;
      updateIndividual(selectedId, (a) => ({
        ...a,
        pitch: Math.min(
          Math.max((a.pitch ?? 0) + radians, -ADJUST_MAX_PITCH_RADIANS),
          ADJUST_MAX_PITCH_RADIANS,
        ),
      }));
    },
    [selectedId, updateIndividual],
  );

  const changeHeightBy = useCallback(
    (meters) => {
      if (!selectedId) return;
      updateIndividual(selectedId, (a) => ({ ...a, up: a.up + meters }));
    },
    [selectedId, updateIndividual],
  );

  const scaleBy = useCallback(
    (ratio) => {
      if (!selectedId) return;
      updateIndividual(selectedId, (a) => ({
        ...a,
        scale: Math.min(Math.max(a.scale * ratio, ADJUST_MIN_SCALE), ADJUST_MAX_SCALE),
      }));
    },
    [selectedId, updateIndividual],
  );

  // 選択中は、そのコンテンツの補正だけをリセットする。未選択なら全体と全ての個別補正をリセットする。
  const resetAdjustments = useCallback(() => {
    // 誤って消した場合に戻せるよう、リセット前の値を控えておく
    setUndoSnapshot({
      individual: individualAdjustmentsRef.current,
      global: globalAdjustmentRef.current,
      frontSaved: frontSavedAdjustmentsRef.current,
      label: selectedId ? "選択中をリセットしました" : "全体をリセットしました",
    });
    if (selectedId) {
      setIndividualAdjustments((prev) => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
      setFrontSavedAdjustments((prev) => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
    } else {
      setIndividualAdjustments({});
      setFrontSavedAdjustments({});
      setGlobalAdjustment(ZERO_GLOBAL_ADJUSTMENT);
    }
  }, [selectedId]);

  const undoReset = useCallback(() => {
    if (!undoSnapshot) return;
    setIndividualAdjustments(undoSnapshot.individual);
    setGlobalAdjustment(undoSnapshot.global);
    setFrontSavedAdjustments(undoSnapshot.frontSaved);
    setUndoSnapshot(null);
  }, [undoSnapshot]);

  // 「正面に呼ぶ」: 選択中のコンテンツを、今見ている正面に、こちらを向けて置く（一時的な見やすさ用）。
  // 具体的な位置はCanvas内（カメラの向きが分かる場所）で求め、onBroughtで受け取って反映する。
  // もう一度押すと、押す前の補正値に戻す。
  const toggleFront = useCallback(() => {
    if (!selectedId) return;
    const saved = frontSavedAdjustments[selectedId];
    if (saved) {
      setIndividualAdjustments((prev) => ({ ...prev, [selectedId]: saved }));
      setFrontSavedAdjustments((prev) => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
    } else {
      bringRequestRef.current = { id: selectedId };
    }
  }, [selectedId, frontSavedAdjustments]);

  const handleBrought = useCallback((id, adjustment) => {
    setFrontSavedAdjustments((prev) => ({
      ...prev,
      [id]: individualAdjustmentsRef.current[id] ?? ZERO_INDIVIDUAL_ADJUSTMENT,
    }));
    setIndividualAdjustments((prev) => ({ ...prev, [id]: adjustment }));
  }, []);

  // 選択中のコンテンツの画面上の位置・大きさへ、ハイライトのDOMを合わせる（毎フレーム呼ばれる）。
  // 毎フレームReactの再レンダーを起こさないよう、DOMを直接更新する。
  const updateReticle = useCallback((state) => {
    const element = reticleRef.current;
    if (!element) return;
    if (!state) {
      element.style.display = "none";
      return;
    }
    element.style.display = "block";
    element.style.transform = `translate(${state.x}px, ${state.y}px)`;
    element.style.setProperty("--reticle-size", `${state.diameter}px`);
  }, []);

  const hintKind = selectedId ? "selected" : "none";
  const isHintVisible = isAdjustMode && !doneHints[hintKind] && !holdPhase && !undoSnapshot;
  const dismissHint = useCallback(() => {
    setDoneHints((prev) => (prev.none && prev.selected ? prev : { none: true, selected: true }));
  }, []);
  useEffect(() => {
    if (!isHintVisible) return undefined;
    const timer = setTimeout(
      () => setDoneHints((prev) => ({ ...prev, [hintKind]: true })),
      HINT_VISIBLE_MS,
    );
    return () => clearTimeout(timer);
  }, [isHintVisible, hintKind]);

  const adjustSurfaceRef = useArViewAdjustGestures({
    enabled: isAdjustMode,
    canPitch: !!selectedId,
    onTap: (x, y) => {
      dismissHint();
      pickRequestRef.current = { x, y };
    },
    onDoubleTap: () => {
      dismissHint();
      toggleFront();
    },
    onRotateByDelta: (deltaPixels) => {
      dismissHint();
      rotateBy(deltaPixels * ADJUST_ROTATE_RADIANS_PER_PIXEL);
    },
    // 下へドラッグ=上端を手前に倒す
    onPitchByDelta: (deltaPixels) => {
      dismissHint();
      pitchBy(deltaPixels * ADJUST_PITCH_RADIANS_PER_PIXEL);
    },
    // 上へドラッグ=上へ
    onHeightByDelta: (deltaPixels) => {
      dismissHint();
      changeHeightBy(-deltaPixels * ADJUST_HEIGHT_METERS_PER_PIXEL);
    },
    onMoveByDelta: (deltaX, deltaY) => {
      dismissHint();
      moveBy(-deltaY * ADJUST_MOVE_METERS_PER_PIXEL, deltaX * ADJUST_MOVE_METERS_PER_PIXEL);
    },
    onScaleBy: scaleBy,
    onLongPressReset: resetAdjustments,
    onHoldPhaseChange: setHoldPhase,
  });

  const selectedPlacement = placementsWithGeometry.find((p) => p.id === selectedId) ?? null;
  const isFrontShown = !!selectedId && !!frontSavedAdjustments[selectedId];

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
            bringRequestRef={bringRequestRef}
            onReticleUpdate={updateReticle}
            onPick={setSelectedId}
            onBrought={handleBrought}
          />

          {isAdjustMode && <div ref={adjustSurfaceRef} className={styles.adjustSurface} />}

          {/* 選択中のコンテンツへ追従するハイライト（位置・大きさはCanvas内の処理が毎フレーム更新する） */}
          {isAdjustMode && (
            <div ref={reticleRef} className={styles.selectionReticle} style={{ display: "none" }}>
              <div
                className={
                  holdPhase === "armed"
                    ? styles.selectionReticleRingArmed
                    : holdPhase === "height"
                      ? styles.selectionReticleRingHeight
                      : styles.selectionReticleRing
                }
              />
              {selectedPlacement && (
                <div className={styles.selectionReticleLabel}>{selectedPlacement.label || "(名前なし)"}</div>
              )}
            </div>
          )}

          {/* 長押し中のフィードバック（0.5秒で高さ調整の待機、そのまま押し続けるとリセット） */}
          {isAdjustMode && holdPhase && (
            <div className={styles.holdToast}>
              {holdPhase === "height" ? (
                <p>↕ 高さを調整中</p>
              ) : (
                <>
                  <p>
                    {selectedPlacement
                      ? "上下にドラッグで高さを調整 ・ このまま押し続けるとリセット"
                      : "このまま押し続けると全体をリセット"}
                  </p>
                  <div className={styles.holdProgress}>
                    <div
                      className={styles.holdProgressFill}
                      style={{ animationDuration: `${HOLD_RESET_MS - HOLD_ARM_MS}ms` }}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {isAdjustMode && undoSnapshot && (
            <div className={styles.undoToast}>
              <span>{undoSnapshot.label}</span>
              <button type="button" onClick={undoReset}>
                元に戻す
              </button>
            </div>
          )}

          {isHintVisible && (
            <p className={styles.operationHint}>
              {selectedPlacement
                ? "1本指=回転(横・縦) ・ 2本指=移動/拡大縮小 ・ 長押し→上下=高さ ・ ダブルタップ=正面に呼ぶ ・ 長押し=リセット"
                : "コンテンツをタップで選択 ・ スワイプ=全体を回転 ・ 2本指=全体を移動"}
            </p>
          )}

          <div className={styles.adjustControls}>
            {isAdjustMode && (
              <button
                type="button"
                className={styles.adjustFineToggle}
                onClick={() => setIsFineAdjustOpen((current) => !current)}
              >
                細かく調整 {isFineAdjustOpen ? "▲" : "▼"}
              </button>
            )}
            <button
              type="button"
              className={isAdjustMode ? styles.adjustToggleActive : styles.adjustToggle}
              onClick={() => setIsAdjustMode((current) => !current)}
            >
              調整モード: {isAdjustMode ? "ON" : "OFF"}
            </button>
          </div>

          {isAdjustMode && isFineAdjustOpen && (
            <div className={styles.adjustPanel}>
              <p className={styles.adjustStatus}>
                {selectedPlacement ? (
                  <>
                    選択中: <strong>{selectedPlacement.label || "(名前なし)"}</strong>
                  </>
                ) : (
                  "全体を調整中（コンテンツをタップすると、その1件だけを調整）"
                )}
              </p>

              <div className={styles.adjustButtons}>
                {selectedPlacement && (
                  <button type="button" onClick={toggleFront}>
                    {isFrontShown ? "元の位置に戻す" : "正面に呼ぶ"}
                  </button>
                )}
                <button type="button" onClick={resetAdjustments}>
                  {selectedPlacement ? "選択中をリセット" : "すべてリセット"}
                </button>
              </div>

              <div className={styles.adjustGrid}>
                <span>回転(横)</span>
                <div className={styles.adjustButtons}>
                  <button type="button" onClick={() => rotateBy(-ADJUST_ROTATE_STEP_RADIANS)}>
                    ◀
                  </button>
                  <button type="button" onClick={() => rotateBy(ADJUST_ROTATE_STEP_RADIANS)}>
                    ▶
                  </button>
                </div>

                <span>回転(縦)</span>
                <div className={styles.adjustButtons}>
                  <button
                    type="button"
                    disabled={!selectedId}
                    onClick={() => pitchBy(-ADJUST_ROTATE_STEP_RADIANS)}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    disabled={!selectedId}
                    onClick={() => pitchBy(ADJUST_ROTATE_STEP_RADIANS)}
                  >
                    ▼
                  </button>
                </div>

                <span>位置(前後)</span>
                <div className={styles.adjustButtons}>
                  <button type="button" onClick={() => moveBy(-ADJUST_MOVE_STEP_METERS, 0)}>
                    手前へ
                  </button>
                  <button type="button" onClick={() => moveBy(ADJUST_MOVE_STEP_METERS, 0)}>
                    奥へ
                  </button>
                </div>

                <span>位置(左右)</span>
                <div className={styles.adjustButtons}>
                  <button type="button" onClick={() => moveBy(0, -ADJUST_MOVE_STEP_METERS)}>
                    左へ
                  </button>
                  <button type="button" onClick={() => moveBy(0, ADJUST_MOVE_STEP_METERS)}>
                    右へ
                  </button>
                </div>

                <span>高さ</span>
                <div className={styles.adjustButtons}>
                  <button
                    type="button"
                    disabled={!selectedId}
                    onClick={() => changeHeightBy(-ADJUST_HEIGHT_STEP_METERS)}
                  >
                    －
                  </button>
                  <button
                    type="button"
                    disabled={!selectedId}
                    onClick={() => changeHeightBy(ADJUST_HEIGHT_STEP_METERS)}
                  >
                    ＋
                  </button>
                </div>

                <span>大きさ</span>
                <div className={styles.adjustButtons}>
                  <button type="button" disabled={!selectedId} onClick={() => scaleBy(1 / ADJUST_SCALE_STEP_RATIO)}>
                    －
                  </button>
                  <button type="button" disabled={!selectedId} onClick={() => scaleBy(ADJUST_SCALE_STEP_RATIO)}>
                    ＋
                  </button>
                </div>
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
