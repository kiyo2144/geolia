"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { DetailedPlacement } from "../ar/view/ArViewScene";
import { SparkSetup } from "../ar/_shared/components/SparkSetup";
import {
  BUILDING_COLOR,
  NAMED_BUILDING_COLOR,
  buildBasemapTexture,
  buildParcelGroup,
  buildTerrainMesh,
  createElevationSampler,
  makeProjector,
} from "./mapMeshBuilders";
import { FirstPersonMinimap } from "./FirstPersonMinimap";
import { getHorizonColor, getLightingConfig, SkyEnvironment } from "./SkyEnvironment";
import { useLocationWeather } from "./useLocationWeather";
import { useDesktopArPlacement } from "./useDesktopArPlacement";
import { DesktopArPlacementPreview } from "./DesktopArPlacementPreview";
import { DesktopArPlacementPanel } from "./DesktopArPlacementPanel";
import { useDesktopAdjustGestures } from "./useDesktopAdjustGestures";
import { GhostablePlacement } from "./GhostablePlacement";
import { isPlacementOccluded } from "./occlusion";
import styles from "./FirstPersonView.module.css";

const TIME_OF_DAY_LABELS = { morning: "朝", day: "昼", night: "夜" };
const WEATHER_TYPE_LABELS = { sunny: "晴れ", cloudy: "曇り", rainy: "雨" };

// マップ上でクリックした地点を中心に、この半径（メートル）の範囲を読み込んで
// 一人称視点で歩き回れるようにする（要件定義: 現地に行かずにAR配置を確認する用途）。
const RADIUS_METERS = 150;
const EYE_HEIGHT_METERS = 2.4;
const MOVE_SPEED_MPS = 3.5;
const DRAG_SENSITIVITY = 0.0035;
const MAX_PITCH = Math.PI / 2 - 0.05;

// 読み込み範囲の端で地形が急に途切れて見えるのを防ぐため、空の色に向かって
// フォグでなだらかに溶け込ませる（境界そのものは隠せないが、唐突な打ち切りが
// 目立たなくなる）。
const FOG_NEAR_METERS = RADIUS_METERS * 0.5;
const FOG_FAR_METERS = RADIUS_METERS * 0.92;

// 画面下部の移動ボタン（キーボードなしでの操作用）
const MOVEMENT_PAD_BUTTONS = [
  { key: "forward", label: "▲", area: "up" },
  { key: "left", label: "◀", area: "left" },
  { key: "right", label: "▶", area: "right" },
  { key: "backward", label: "▼", area: "down" },
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function makeBboxAroundPoint(lng, lat, radiusMeters) {
  const metersPerDegLat = 110540;
  const metersPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLat = radiusMeters / metersPerDegLat;
  const dLng = radiusMeters / metersPerDegLng;
  return { minLng: lng - dLng, maxLng: lng + dLng, minLat: lat - dLat, maxLat: lat + dLat };
}

/** 周辺のAR配置を取得し、この画面のローカル座標(localX/localY/localZ)を付けて返す */
async function fetchPlacementsWithLocalCoords(supabase, origin, project, sampleElevation, minElevation) {
  const { data } = await supabase.rpc("ar_placements_nearby", {
    center_lng: origin.lng,
    center_lat: origin.lat,
    radius_meters: RADIUS_METERS,
    max_count: 100,
  });
  return (data?.features ?? []).map((feature) => {
    const p = feature.properties;
    const { x, y: northMeters } = project(p.lng, p.lat);
    // ar_placements_nearby はvertical_offsetを返さないため、地表面の高さではなく
    // 設置時に確定した絶対高度(altitude。vertical_offset適用済み)を優先して使う。
    // 高度が無い古いデータ等のフォールバックとしてのみ、地表面の高さを使う。
    const baseElevation = p.altitude ?? sampleElevation(p.lng, p.lat);
    const groundY = baseElevation - minElevation;
    return { ...p, localX: x, localY: groundY, localZ: -northMeters };
  });
}

/**
 * WASDで移動、ドラッグで視点回転する簡易的な一人称カメラ操作。
 * 実際の道路・敷地境界などによる移動制約は今回のスコープでは扱わず、
 * 読み込み範囲内を自由に歩き回れるようにする（将来的な改善事項）。
 */
function FirstPersonControls({
  project,
  sampleElevation,
  minElevation,
  boundsMeters,
  isDraggingRef,
  moveInputRef,
  playerStateRef,
  teleportRequestRef,
  lookAtRequestRef,
}) {
  const { camera, gl } = useThree();
  const keysRef = useRef({});
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const positionRef = useRef(new THREE.Vector3(0, EYE_HEIGHT_METERS, 0));
  const lastPointerRef = useRef(null);

  useEffect(() => {
    const canvasEl = gl.domElement;

    const handleKeyDown = (event) => {
      keysRef.current[event.code] = true;
    };
    const handleKeyUp = (event) => {
      keysRef.current[event.code] = false;
    };
    const handlePointerDown = (event) => {
      isDraggingRef.current = true;
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      canvasEl.setPointerCapture?.(event.pointerId);
    };
    const handlePointerMove = (event) => {
      if (!isDraggingRef.current || !lastPointerRef.current) return;
      const dx = event.clientX - lastPointerRef.current.x;
      const dy = event.clientY - lastPointerRef.current.y;
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      yawRef.current -= dx * DRAG_SENSITIVITY;
      pitchRef.current = clamp(pitchRef.current - dy * DRAG_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
    };
    const handlePointerUp = (event) => {
      isDraggingRef.current = false;
      lastPointerRef.current = null;
      canvasEl.releasePointerCapture?.(event.pointerId);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    canvasEl.addEventListener("pointerdown", handlePointerDown);
    canvasEl.addEventListener("pointermove", handlePointerMove);
    canvasEl.addEventListener("pointerup", handlePointerUp);
    canvasEl.addEventListener("pointerleave", handlePointerUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      canvasEl.removeEventListener("pointerdown", handlePointerDown);
      canvasEl.removeEventListener("pointermove", handlePointerMove);
      canvasEl.removeEventListener("pointerup", handlePointerUp);
      canvasEl.removeEventListener("pointerleave", handlePointerUp);
    };
  }, [gl, isDraggingRef]);

  useFrame((_state, delta) => {
    // サブマップ上のクリックによる瞬間移動リクエストがあれば先に反映する
    if (teleportRequestRef.current) {
      const { x, z } = teleportRequestRef.current;
      positionRef.current.x = clamp(x, -boundsMeters, boundsMeters);
      positionRef.current.z = clamp(z, -boundsMeters, boundsMeters);
      teleportRequestRef.current = null;
    }

    // AR設置の位置確定時など、狙った地点に視点を振り向けたいときのリクエストを処理する
    if (lookAtRequestRef?.current) {
      const { x: targetX, z: targetZ, y: targetY } = lookAtRequestRef.current;
      const dx = targetX - positionRef.current.x;
      const dz = targetZ - positionRef.current.z;
      yawRef.current = Math.atan2(positionRef.current.x - targetX, positionRef.current.z - targetZ);
      if (targetY !== undefined) {
        const horizontalDist = Math.max(Math.hypot(dx, dz), 0.01);
        const dy = targetY - positionRef.current.y;
        pitchRef.current = clamp(Math.atan2(dy, horizontalDist), -MAX_PITCH, MAX_PITCH);
      }
      lookAtRequestRef.current = null;
    }

    const keys = keysRef.current;
    const padInput = moveInputRef.current;
    const yaw = yawRef.current;
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    const move = new THREE.Vector3();
    if (keys["KeyW"] || keys["ArrowUp"] || padInput.forward) move.add(forward);
    if (keys["KeyS"] || keys["ArrowDown"] || padInput.backward) move.sub(forward);
    if (keys["KeyD"] || keys["ArrowRight"] || padInput.right) move.add(right);
    if (keys["KeyA"] || keys["ArrowLeft"] || padInput.left) move.sub(right);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(MOVE_SPEED_MPS * delta);
      positionRef.current.x = clamp(positionRef.current.x + move.x, -boundsMeters, boundsMeters);
      positionRef.current.z = clamp(positionRef.current.z + move.z, -boundsMeters, boundsMeters);
    }

    // 現在地点の地面の高さに追従させる（読み込み済みの標高データから再サンプリング）
    const { lng, lat } = project.unproject(positionRef.current.x, -positionRef.current.z);
    const groundY = sampleElevation(lng, lat) - minElevation;
    positionRef.current.y = groundY + EYE_HEIGHT_METERS;

    camera.position.copy(positionRef.current);
    camera.rotation.set(pitchRef.current, yaw, 0, "YXZ");

    // サブマップ側は独自のタイマーでこの値を読み取って表示を更新する
    // （毎フレームDOMもしくは地図ライブラリを直接更新するとコストが高いため）
    playerStateRef.current.x = positionRef.current.x;
    playerStateRef.current.z = positionRef.current.z;
    playerStateRef.current.yaw = yaw;
  });

  return null;
}

/** キーボードなしでも移動できるよう、画面下部に半透明の方向ボタンを表示する */
function MovementPad({ moveInputRef }) {
  const setPressed = (key, pressed) => () => {
    moveInputRef.current[key] = pressed;
  };

  return (
    <div className={styles.movementPad}>
      {MOVEMENT_PAD_BUTTONS.map(({ key, label, area }) => (
        <button
          key={key}
          type="button"
          className={styles.padButton}
          style={{ gridArea: area }}
          onPointerDown={setPressed(key, true)}
          onPointerUp={setPressed(key, false)}
          onPointerLeave={setPressed(key, false)}
          onPointerCancel={setPressed(key, false)}
          onContextMenu={(event) => event.preventDefault()}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * マップ上でクリックした任意の地点を、一人称視点で見回しながら確認できる
 * オーバーレイ。現在チェックが入っているレイヤー（森林簿・地籍・OSM建物）と、
 * 周辺のAR配置を、実際の位置関係のまま3D空間に再現する。
 */
export function FirstPersonView({
  origin,
  forestVisible,
  landVisible,
  landColorMode,
  buildingsVisible,
  basemap,
  supabase,
  onClose,
}) {
  const [sceneData, setSceneData] = useState(null);
  const [status, setStatus] = useState("周辺データを読み込み中...");
  const isDraggingRef = useRef(false);
  const moveInputRef = useRef({ forward: false, backward: false, left: false, right: false });
  const playerStateRef = useRef({ x: 0, z: 0, yaw: 0 });
  const teleportRequestRef = useRef(null);
  const lookAtRequestRef = useRef(null);
  const { timeOfDay, weatherType } = useLocationWeather(origin.lat, origin.lng);
  const lighting = getLightingConfig(timeOfDay, weatherType);
  const horizonColor = getHorizonColor(timeOfDay, weatherType);

  // シェア直後に、その場でAR配置が一人称視点内に表示されるようにするための再取得。
  const refetchPlacements = useCallback(async () => {
    if (!sceneData) return;
    const placements = await fetchPlacementsWithLocalCoords(
      supabase,
      origin,
      sceneData.project,
      sceneData.sampleElevation,
      sceneData.minElevation,
    );
    setSceneData((current) => (current ? { ...current, placements } : current));
  }, [sceneData, supabase, origin]);

  // 一人称視点画面から、カメラを使わずマップ上の位置・標高を基準にAR配置を
  // 新規登録する機能（sceneData読み込み前はproject等がundefinedになるが、
  // 「AR設置」ボタン自体をsceneData読み込み後にのみ表示するため問題ない）。
  const desktopPlacement = useDesktopArPlacement({
    project: sceneData?.project,
    sampleElevation: sceneData?.sampleElevation,
    minElevation: sceneData?.minElevation,
    playerStateRef,
    lookAtRequestRef,
    supabase,
    onSaved: refetchPlacements,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const bbox = makeBboxAroundPoint(origin.lng, origin.lat, RADIUS_METERS);
      const project = makeProjector(bbox);
      const sampleElevation = await createElevationSampler(bbox);
      const texture = await buildBasemapTexture(bbox, basemap).catch(() => null);
      const { mesh: terrainMesh, minElevation } = buildTerrainMesh(bbox, sampleElevation, project, texture, {
        skirt: true,
      });

      const bboxParam = {
        min_lng: bbox.minLng,
        min_lat: bbox.minLat,
        max_lng: bbox.maxLng,
        max_lat: bbox.maxLat,
      };

      const groups = [terrainMesh];
      const fetches = [];

      if (forestVisible) {
        fetches.push(
          supabase.rpc("forest_parcels_in_bbox", bboxParam).then(({ data }) => {
            if (data?.features?.length) {
              groups.push(
                buildParcelGroup("forest_parcels", data.features, "color", project, sampleElevation, minElevation),
              );
            }
          }),
        );
      }
      if (landVisible) {
        fetches.push(
          supabase.rpc("land_parcels_in_bbox", bboxParam).then(({ data }) => {
            if (data?.features?.length) {
              const colorField = landColorMode === "seido" ? "color_seido" : "color_koaza";
              groups.push(
                buildParcelGroup("land_parcels", data.features, colorField, project, sampleElevation, minElevation),
              );
            }
          }),
        );
      }
      let buildingFeatures = [];
      if (buildingsVisible) {
        fetches.push(
          supabase.rpc("osm_buildings_in_bbox", bboxParam).then(({ data }) => {
            if (data?.features?.length) {
              for (const feature of data.features) {
                feature.properties.color = feature.properties.name ? NAMED_BUILDING_COLOR : BUILDING_COLOR;
              }
              buildingFeatures = data.features;
              groups.push(
                buildParcelGroup("osm_buildings", data.features, "color", project, sampleElevation, minElevation),
              );
            }
          }),
        );
      }

      let placements = [];
      fetches.push(
        fetchPlacementsWithLocalCoords(supabase, origin, project, sampleElevation, minElevation).then((result) => {
          placements = result;
        }),
      );

      await Promise.all(fetches);

      if (cancelled) return;
      setSceneData({
        project,
        sampleElevation,
        minElevation,
        groups,
        placements,
        buildingFeatures,
      });
      setStatus("");
    })().catch((error) => {
      console.error("一人称ビューの読み込みに失敗しました:", error);
      if (!cancelled) setStatus("読み込みに失敗しました");
    });

    return () => {
      cancelled = true;
    };
  }, [origin, forestVisible, landVisible, landColorMode, buildingsVisible, basemap, supabase]);

  const getPublicUrl = (storagePath, bucket = "ar-assets") =>
    supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;

  // 「配置調整」がONの間、Canvasの上に重ねた透明なオーバーレイでドラッグ・ホイールを
  // 拾い、AR配置の回転・高さ・拡大縮小を操作する（一人称視点のカメラ操作の代わりに使う）。
  const adjustGestureEnabled = desktopPlacement.active && desktopPlacement.step === "adjust" && desktopPlacement.isAdjustMode;
  const adjustSurfaceRef = useDesktopAdjustGestures({
    enabled: adjustGestureEnabled,
    onRotateByDelta: desktopPlacement.rotateByDelta,
    onHeightByDelta: desktopPlacement.changeHeightByDelta,
    onScaleStep: desktopPlacement.changeScale,
  });

  const hasSplat = useMemo(
    () =>
      (sceneData?.placements ?? []).some((p) => p.asset_type === "gaussian_splat") ||
      desktopPlacement.dataFormat === "splat",
    [sceneData, desktopPlacement.dataFormat],
  );

  // 地面下・建物内にあるAR配置は、通常描画だと地形/建物に隠れて全く見えないため、
  // 半透明で透けて見える表示に切り替える対象をあらかじめ判定しておく。
  const occludedPlacementIds = useMemo(() => {
    if (!sceneData) return new Set();
    const ids = new Set();
    for (const placement of sceneData.placements) {
      if (
        isPlacementOccluded(placement, {
          sampleElevation: sceneData.sampleElevation,
          project: sceneData.project,
          buildingFeatures: sceneData.buildingFeatures,
        })
      ) {
        ids.add(placement.id);
      }
    }
    return ids;
  }, [sceneData]);

  return (
    <div className={styles.overlay}>
      <div className={styles.topBar}>
        <button type="button" className={styles.closeButton} onClick={onClose}>
          閉じる
        </button>
        {sceneData && !desktopPlacement.active && (
          <button type="button" className={styles.closeButton} onClick={desktopPlacement.open}>
            AR設置
          </button>
        )}
        <p className={styles.hint}>W/A/S/D または画面下部のボタン: 移動　ドラッグ: 視点回転</p>
        <p className={styles.hint}>
          {TIME_OF_DAY_LABELS[timeOfDay]}・{WEATHER_TYPE_LABELS[weatherType]}
        </p>
      </div>

      {status && <p className={styles.status}>{status}</p>}

      {sceneData && (
        <Canvas
          className={styles.canvas}
          camera={{ fov: 75, near: 0.1, far: 2000, position: [0, EYE_HEIGHT_METERS, 0] }}
          gl={{ antialias: true }}
        >
          <fog attach="fog" args={[horizonColor, FOG_NEAR_METERS, FOG_FAR_METERS]} />
          <SkyEnvironment timeOfDay={timeOfDay} weatherType={weatherType} />
          <ambientLight color={lighting.ambient.color} intensity={lighting.ambient.intensity} />
          <directionalLight
            color={lighting.directional.color}
            intensity={lighting.directional.intensity}
            position={lighting.directional.position}
          />
          <hemisphereLight
            args={[lighting.hemisphere.sky, lighting.hemisphere.ground, lighting.hemisphere.intensity]}
          />
          {hasSplat && <SparkSetup />}

          <FirstPersonControls
            project={sceneData.project}
            sampleElevation={sceneData.sampleElevation}
            minElevation={sceneData.minElevation}
            boundsMeters={RADIUS_METERS * 0.95}
            isDraggingRef={isDraggingRef}
            moveInputRef={moveInputRef}
            playerStateRef={playerStateRef}
            teleportRequestRef={teleportRequestRef}
            lookAtRequestRef={lookAtRequestRef}
          />

          {sceneData.groups.map((group, index) => (
            <primitive key={index} object={group} />
          ))}

          <Suspense fallback={null}>
            {sceneData.placements.map((placement) => (
              <group
                key={placement.id}
                position={[placement.localX, placement.localY, placement.localZ]}
              >
                <GhostablePlacement ghost={occludedPlacementIds.has(placement.id)}>
                  <DetailedPlacement
                    placement={placement}
                    url={getPublicUrl(placement.storage_path)}
                    motionAssetUrl={
                      placement.motion_storage_path
                        ? getPublicUrl(placement.motion_storage_path, "ar-motion-assets")
                        : null
                    }
                  />
                </GhostablePlacement>
              </group>
            ))}
          </Suspense>

          {desktopPlacement.active && desktopPlacement.dataUrl && (
            <DesktopArPlacementPreview
              mode={desktopPlacement.step === "aiming" ? "aiming" : "fixed"}
              playerStateRef={playerStateRef}
              project={sceneData.project}
              sampleElevation={sceneData.sampleElevation}
              minElevation={sceneData.minElevation}
              aimLngLat={desktopPlacement.aimLngLat}
              confirmedLngLat={desktopPlacement.confirmedLngLat}
              adjustment={desktopPlacement.adjustment}
              dataFormat={desktopPlacement.dataFormat}
              dataUrl={desktopPlacement.dataUrl}
              splatFileType={desktopPlacement.splatFileType}
              decorationPresetKey={desktopPlacement.decorationPresetKey}
              imageEffectKey={desktopPlacement.imageEffectKey}
              livePositionRef={desktopPlacement.livePositionRef}
              buildingFeatures={sceneData.buildingFeatures}
            />
          )}
        </Canvas>
      )}

      {adjustGestureEnabled && <div ref={adjustSurfaceRef} className={styles.adjustSurface} />}

      {desktopPlacement.active && <DesktopArPlacementPanel placement={desktopPlacement} />}

      {sceneData && (
        <FirstPersonMinimap
          origin={origin}
          project={sceneData.project}
          placements={sceneData.placements}
          boundsMeters={RADIUS_METERS * 0.95}
          playerStateRef={playerStateRef}
          teleportRequestRef={teleportRequestRef}
          placementPickActive={desktopPlacement.active && desktopPlacement.step === "aiming"}
          onPlacementPick={desktopPlacement.pickAimPosition}
          pickedLngLat={desktopPlacement.active ? desktopPlacement.aimLngLat : null}
        />
      )}

      {sceneData && <MovementPad moveInputRef={moveInputRef} />}
    </div>
  );
}
