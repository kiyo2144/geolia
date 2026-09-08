"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import { getLightingConfig, SkyEnvironment } from "./SkyEnvironment";
import { useLocationWeather } from "./useLocationWeather";
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
  const { timeOfDay, weatherType } = useLocationWeather(origin.lat, origin.lng);
  const lighting = getLightingConfig(timeOfDay, weatherType);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const bbox = makeBboxAroundPoint(origin.lng, origin.lat, RADIUS_METERS);
      const project = makeProjector(bbox);
      const sampleElevation = await createElevationSampler(bbox);
      const texture = await buildBasemapTexture(bbox, basemap).catch(() => null);
      const { mesh: terrainMesh, minElevation } = buildTerrainMesh(bbox, sampleElevation, project, texture);

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
      if (buildingsVisible) {
        fetches.push(
          supabase.rpc("osm_buildings_in_bbox", bboxParam).then(({ data }) => {
            if (data?.features?.length) {
              for (const feature of data.features) {
                feature.properties.color = feature.properties.name ? NAMED_BUILDING_COLOR : BUILDING_COLOR;
              }
              groups.push(
                buildParcelGroup("osm_buildings", data.features, "color", project, sampleElevation, minElevation),
              );
            }
          }),
        );
      }

      let placements = [];
      fetches.push(
        supabase
          .rpc("ar_placements_nearby", {
            center_lng: origin.lng,
            center_lat: origin.lat,
            radius_meters: RADIUS_METERS,
            max_count: 100,
          })
          .then(({ data }) => {
            placements = (data?.features ?? []).map((feature) => {
              const p = feature.properties;
              const { x, y: northMeters } = project(p.lng, p.lat);
              const groundY = sampleElevation(p.lng, p.lat) - minElevation;
              return { ...p, localX: x, localY: groundY, localZ: -northMeters };
            });
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

  const hasSplat = useMemo(
    () => (sceneData?.placements ?? []).some((p) => p.asset_type === "gaussian_splat"),
    [sceneData],
  );

  return (
    <div className={styles.overlay}>
      <div className={styles.topBar}>
        <button type="button" className={styles.closeButton} onClick={onClose}>
          閉じる
        </button>
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
                <DetailedPlacement
                  placement={placement}
                  url={getPublicUrl(placement.storage_path)}
                  motionAssetUrl={
                    placement.motion_storage_path
                      ? getPublicUrl(placement.motion_storage_path, "ar-motion-assets")
                      : null
                  }
                />
              </group>
            ))}
          </Suspense>
        </Canvas>
      )}

      {sceneData && (
        <FirstPersonMinimap
          origin={origin}
          project={sceneData.project}
          placements={sceneData.placements}
          boundsMeters={RADIUS_METERS * 0.95}
          playerStateRef={playerStateRef}
          teleportRequestRef={teleportRequestRef}
        />
      )}

      {sceneData && <MovementPad moveInputRef={moveInputRef} />}
    </div>
  );
}
