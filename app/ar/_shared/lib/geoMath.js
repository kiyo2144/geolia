// 緯度経度に関する幾何計算。camp/test/react-components の同名モジュールを移植したもの。

const EARTH_RADIUS_METERS = 6378137;

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

/**
 * 2点間の緯度経度差を、origin を原点とした東西(east)・南北(north)方向の
 * ローカル平面座標（メートル）に変換する。数十〜数百m程度の近距離向けの近似。
 */
export function latLngToLocalMeters(origin, target) {
  const deltaLatRad = toRadians(target.lat - origin.lat);
  const deltaLngRad = toRadians(target.lng - origin.lng);
  const averageLatRad = toRadians((origin.lat + target.lat) / 2);

  const north = deltaLatRad * EARTH_RADIUS_METERS;
  const east = deltaLngRad * EARTH_RADIUS_METERS * Math.cos(averageLatRad);

  return { east, north };
}

/**
 * latLngToLocalMeters の逆変換。origin からのローカル平面座標(east/north, メートル)を
 * 緯度経度に戻す。画面上でAR配置を微調整した結果を「実際の設置場所」として
 * 緯度経度に確定させる用途で使う。
 */
export function localMetersToLatLng(origin, { east, north }) {
  const deltaLatRad = north / EARTH_RADIUS_METERS;
  const averageLatRad = toRadians(origin.lat) + deltaLatRad / 2;
  const deltaLngRad = east / (EARTH_RADIUS_METERS * Math.cos(averageLatRad));

  return {
    lat: origin.lat + toDegrees(deltaLatRad),
    lng: origin.lng + toDegrees(deltaLngRad),
  };
}

/** 2点間の直線距離（メートル、Haversine公式） */
export function haversineDistanceMeters(origin, target) {
  const deltaLatRad = toRadians(target.lat - origin.lat);
  const deltaLngRad = toRadians(target.lng - origin.lng);
  const originLatRad = toRadians(origin.lat);
  const targetLatRad = toRadians(target.lat);

  const a =
    Math.sin(deltaLatRad / 2) ** 2 +
    Math.cos(originLatRad) * Math.cos(targetLatRad) * Math.sin(deltaLngRad / 2) ** 2;

  const centralAngle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * centralAngle;
}

/** origin から見た target の真北基準の方位角（度、0-360） */
export function bearingDegrees(origin, target) {
  const originLatRad = toRadians(origin.lat);
  const targetLatRad = toRadians(target.lat);
  const deltaLngRad = toRadians(target.lng - origin.lng);

  const y = Math.sin(deltaLngRad) * Math.cos(targetLatRad);
  const x =
    Math.cos(originLatRad) * Math.sin(targetLatRad) -
    Math.sin(originLatRad) * Math.cos(targetLatRad) * Math.cos(deltaLngRad);

  const bearing = toDegrees(Math.atan2(y, x));

  return (bearing + 360) % 360;
}
