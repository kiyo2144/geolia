"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// 一人称視点（FirstPersonView）の空を、時間帯（朝・昼・夜）と天候（晴れ・曇り・雨）に
// 応じて表現する。移動範囲（半径150m程度）よりも十分大きいドーム状の空を配置する。
const SKY_RADIUS = 900;

const BASE_SKY_COLORS = {
  morning: { top: "#7fa8cf", bottom: "#ffd3a0" },
  day: { top: "#2f7fd8", bottom: "#bfe4ff" },
  night: { top: "#01030a", bottom: "#0b1330" },
};

// 天候による彩度の低下（1=そのまま、小さいほど灰色寄りになる）
const WEATHER_DIM = { sunny: 1, cloudy: 0.55, rainy: 0.32 };

// 太陽のおおまかな高度・方位（時間帯ごと、簡易近似）
const SUN_ANGLES = {
  morning: { elevationDeg: 16, azimuthDeg: 100 },
  day: { elevationDeg: 58, azimuthDeg: 165 },
};
const MOON_ANGLE = { elevationDeg: 45, azimuthDeg: 210 };

function mixTowardGray(hex, amount) {
  const c = new THREE.Color(hex);
  const gray = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  c.r = THREE.MathUtils.lerp(gray, c.r, amount);
  c.g = THREE.MathUtils.lerp(gray, c.g, amount);
  c.b = THREE.MathUtils.lerp(gray, c.b, amount);
  return c;
}

function angleToDirection(elevationDeg, azimuthDeg, radius) {
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(
    radius * Math.cos(elevation) * Math.sin(azimuth),
    radius * Math.sin(elevation),
    -radius * Math.cos(elevation) * Math.cos(azimuth),
  );
}

/**
 * 時間帯・天候に応じたライティング設定（色・強さ）を返す。
 * FirstPersonView側の ambientLight / directionalLight / hemisphereLight に使う。
 */
export function getLightingConfig(timeOfDay, weatherType) {
  const dim = WEATHER_DIM[weatherType] ?? 1;

  if (timeOfDay === "night") {
    return {
      ambient: { color: "#334066", intensity: 0.3 + 0.1 * dim },
      directional: {
        color: "#7f94c9",
        intensity: weatherType === "sunny" ? 0.3 : 0.1,
        position: angleToDirection(MOON_ANGLE.elevationDeg, MOON_ANGLE.azimuthDeg, 200),
      },
      hemisphere: { sky: "#1b2447", ground: "#05060a", intensity: 0.35 },
    };
  }

  const sun = SUN_ANGLES[timeOfDay] ?? SUN_ANGLES.day;
  const tint = timeOfDay === "morning" ? "#ffdcb0" : "#fff6e6";
  return {
    ambient: { color: "#ffffff", intensity: 0.55 + 0.35 * dim },
    directional: {
      color: tint,
      intensity: 0.4 + 1.1 * dim,
      position: angleToDirection(sun.elevationDeg, sun.azimuthDeg, 200),
    },
    hemisphere: { sky: "#bcd8ff", ground: "#4a4a3a", intensity: 0.3 + 0.4 * dim },
  };
}

function buildGlowTexture(colorInner, colorOuter, size = 128) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, colorInner);
  gradient.addColorStop(0.35, colorInner);
  gradient.addColorStop(1, colorOuter);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function buildCloudTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const blobs = [
    [70, 75, 55],
    [130, 60, 60],
    [190, 78, 48],
    [110, 55, 42],
    [160, 48, 38],
  ];
  for (const [x, y, r] of blobs) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

/** 空全体を覆う大きな球体ドーム。天頂〜地平線のグラデーションを頂点カラーで表現する */
function SkyDome({ timeOfDay, weatherType }) {
  const [geometry] = useState(() => {
    const geom = new THREE.SphereGeometry(SKY_RADIUS, 32, 24, 0, Math.PI * 2, 0, Math.PI);
    geom.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(geom.attributes.position.count * 3), 3));
    return geom;
  });
  const meshRef = useRef(null);

  useEffect(() => {
    if (!meshRef.current) return;
    const dim = WEATHER_DIM[weatherType] ?? 1;
    const { top, bottom } = BASE_SKY_COLORS[timeOfDay];
    const topColor = mixTowardGray(top, dim);
    const bottomColor = mixTowardGray(bottom, dim);
    const position = meshRef.current.geometry.attributes.position;
    const colorAttr = meshRef.current.geometry.attributes.color;
    const color = new THREE.Color();
    for (let i = 0; i < position.count; i++) {
      const t = THREE.MathUtils.clamp((position.getY(i) / SKY_RADIUS + 0.15) / 1.15, 0, 1);
      color.copy(bottomColor).lerp(topColor, t);
      colorAttr.setXYZ(i, color.r, color.g, color.b);
    }
    colorAttr.needsUpdate = true;
  }, [timeOfDay, weatherType]);

  return (
    <mesh ref={meshRef} geometry={geometry} renderOrder={-2}>
      <meshBasicMaterial vertexColors side={THREE.BackSide} depthWrite={false} />
    </mesh>
  );
}

/** 太陽（晴れの朝・昼のみ表示） */
function Sun({ timeOfDay }) {
  const [texture] = useState(() => buildGlowTexture("rgba(255,250,220,1)", "rgba(255,250,220,0)"));
  const ref = useRef(null);
  const angles = SUN_ANGLES[timeOfDay] ?? SUN_ANGLES.day;
  const [position] = useState(() => angleToDirection(angles.elevationDeg, angles.azimuthDeg, SKY_RADIUS * 0.9));

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 1 + Math.sin(clock.getElapsedTime() * 0.6) * 0.04;
    ref.current.scale.set(70 * pulse, 70 * pulse, 1);
  });

  return (
    <sprite ref={ref} position={position} renderOrder={-1}>
      <spriteMaterial map={texture} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  );
}

/** 月（晴れの夜のみ表示） */
function Moon() {
  const [texture] = useState(() => buildGlowTexture("rgba(235,240,255,1)", "rgba(235,240,255,0)"));
  const [position] = useState(() =>
    angleToDirection(MOON_ANGLE.elevationDeg, MOON_ANGLE.azimuthDeg, SKY_RADIUS * 0.9),
  );

  return (
    <sprite position={position} renderOrder={-1} scale={[45, 45, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  );
}

const STAR_COUNT = 700;

/** 星空（晴れの夜のみ表示） */
function Stars() {
  const [geometry] = useState(() => {
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.85); // 地平線付近は少なめにする
      const r = SKY_RADIUS * 0.95;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geom;
  });
  const [texture] = useState(() => buildGlowTexture("rgba(255,255,255,1)", "rgba(255,255,255,0)", 32));
  const materialRef = useRef(null);

  useFrame(({ clock }) => {
    if (!materialRef.current) return;
    materialRef.current.opacity = 0.7 + Math.sin(clock.getElapsedTime() * 1.4) * 0.15;
  });

  return (
    <points geometry={geometry} renderOrder={-1}>
      <pointsMaterial
        ref={materialRef}
        map={texture}
        size={3}
        sizeAttenuation={false}
        transparent
        depthWrite={false}
        opacity={0.8}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

const CLOUD_COUNT = 10;

/** 雲（曇り・雨のときに表示） */
function Clouds({ weatherType }) {
  const [texture] = useState(buildCloudTexture);
  const groupRef = useRef(null);
  const [cloudDefs] = useState(() =>
    Array.from({ length: CLOUD_COUNT }, () => ({
      azimuth: Math.random() * Math.PI * 2,
      elevationDeg: 12 + Math.random() * 45,
      scale: 90 + Math.random() * 110,
      speed: 0.008 + Math.random() * 0.012,
    })),
  );

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.getElapsedTime();
    groupRef.current.children.forEach((sprite, i) => {
      const def = cloudDefs[i];
      const azimuthDeg = THREE.MathUtils.radToDeg(def.azimuth) + t * def.speed * 60;
      const position = angleToDirection(def.elevationDeg, azimuthDeg, SKY_RADIUS * 0.85);
      sprite.position.copy(position);
    });
  });

  const opacity = weatherType === "rainy" ? 0.92 : 0.75;
  const tint = weatherType === "rainy" ? "#767c85" : "#ffffff";

  return (
    <group ref={groupRef}>
      {cloudDefs.map((def, i) => (
        <sprite key={i} scale={[def.scale, def.scale * 0.5, 1]} renderOrder={-1}>
          <spriteMaterial map={texture} color={tint} transparent opacity={opacity} depthWrite={false} />
        </sprite>
      ))}
    </group>
  );
}

const RAIN_COUNT = 900;
const RAIN_HEIGHT = 35;
const RAIN_SPREAD = 55;
const RAIN_FALL_SPEED = 26;

/** 雨（プレイヤーの水平位置に追従して常に周囲に降らせる） */
function Rain() {
  const { camera } = useThree();
  const [geometry] = useState(() => {
    const positions = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * RAIN_SPREAD * 2;
      positions[i * 3 + 1] = Math.random() * RAIN_HEIGHT;
      positions[i * 3 + 2] = (Math.random() - 0.5) * RAIN_SPREAD * 2;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geom;
  });
  const groupRef = useRef(null);
  const pointsRef = useRef(null);

  useFrame((_state, delta) => {
    if (!groupRef.current || !pointsRef.current) return;
    groupRef.current.position.x = camera.position.x;
    groupRef.current.position.z = camera.position.z;

    const position = pointsRef.current.geometry.attributes.position;
    for (let i = 0; i < RAIN_COUNT; i++) {
      let y = position.getY(i) - RAIN_FALL_SPEED * delta;
      if (y < 0) y = RAIN_HEIGHT;
      position.setY(i, y);
    }
    position.needsUpdate = true;
  });

  return (
    <group ref={groupRef}>
      <points ref={pointsRef} geometry={geometry}>
        <pointsMaterial
          color="#cfe0ff"
          size={0.3}
          transparent
          opacity={0.55}
          depthWrite={false}
          sizeAttenuation
        />
      </points>
    </group>
  );
}

/**
 * 一人称視点（FirstPersonView）の空を、時間帯・天候に応じて表現する。
 * timeOfDay: 'morning' | 'day' | 'night'　weatherType: 'sunny' | 'cloudy' | 'rainy'
 */
export function SkyEnvironment({ timeOfDay, weatherType }) {
  const showSun = weatherType === "sunny" && timeOfDay !== "night";
  const showMoonAndStars = weatherType === "sunny" && timeOfDay === "night";
  const showClouds = weatherType === "cloudy" || weatherType === "rainy";
  const showRain = weatherType === "rainy";

  return (
    <>
      <SkyDome timeOfDay={timeOfDay} weatherType={weatherType} />
      {showSun && <Sun timeOfDay={timeOfDay} />}
      {showMoonAndStars && (
        <>
          <Moon />
          <Stars />
        </>
      )}
      {showClouds && <Clouds weatherType={weatherType} />}
      {showRain && <Rain />}
    </>
  );
}
