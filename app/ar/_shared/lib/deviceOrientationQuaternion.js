import * as THREE from "three";

const Z_AXIS = new THREE.Vector3(0, 0, 1);

// 端末の「画面が上を向いた状態」の座標系を three.js のワールド座標系
// （Y-up, カメラは -Z を向く）に合わせるための基準回転。
const BASE_ADJUSTMENT_QUATERNION = new THREE.Quaternion(
  -Math.sqrt(0.5),
  0,
  0,
  Math.sqrt(0.5),
);

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * DeviceOrientationEvent の alpha/beta/gamma と画面の回転角から、
 * three.js カメラに適用するクォータニオンを求める。
 * （旧 three.js examples の DeviceOrientationControls と同じ変換式）
 *
 * 注意: alpha は端末起動時を基準にした相対角のことが多く、必ずしも
 * 真北を指さない（特に iOS）。厳密な方位合わせが必要な場合は
 * webkitCompassHeading（iOS）や 'deviceorientationabsolute'（Android）を
 * 別途キャリブレーションに利用すること。
 */
export function computeCameraQuaternion({ alpha, beta, gamma, screenAngle = 0 }) {
  const euler = new THREE.Euler(
    toRadians(beta),
    toRadians(alpha),
    toRadians(-gamma),
    "YXZ",
  );

  const quaternion = new THREE.Quaternion().setFromEuler(euler);
  quaternion.multiply(BASE_ADJUSTMENT_QUATERNION);
  quaternion.multiply(
    new THREE.Quaternion().setFromAxisAngle(Z_AXIS, toRadians(-screenAngle)),
  );

  return quaternion;
}
