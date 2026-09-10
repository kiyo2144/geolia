// 一人称視点画面で、AR配置が地形の下、または建物の内部にあるかどうかを判定する。
// 地面下・建物内にあると、通常の描画では地形/建物メッシュに隠れて全く見えなくなって
// しまうため、判定結果を使って半透明の「透けて見える」表示に切り替える。

// レイキャスティング法による点と多角形（1つの環）の包含判定
function isPointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// 穴（中庭など）を考慮した多角形包含判定。ringsは [外周, ...穴] の配列で、
// 各環はローカル座標(x, y)の配列。
function isPointInPolygonWithHoles(x, y, rings) {
  const [exterior, ...holes] = rings;
  if (!exterior || !isPointInRing(x, y, exterior)) return false;
  for (const hole of holes) {
    if (isPointInRing(x, y, hole)) return false;
  }
  return true;
}

const UNDERGROUND_MARGIN_METERS = 0.3;
const BUILDING_BASE_MARGIN_METERS = 0.1;

/**
 * AR配置1件について、地面下または建物内部にあるかどうかを判定する。
 * buildingFeatures: osm_buildings_in_bbox から取得した生のGeoJSON Feature配列
 * （buildParcelGroupに渡すのと同じもの）。
 */
export function isPlacementOccluded({ lng, lat, altitude }, { sampleElevation, project, buildingFeatures }) {
  if (lng == null || lat == null || altitude == null) return false;

  const groundElevation = sampleElevation(lng, lat);
  if (altitude < groundElevation - UNDERGROUND_MARGIN_METERS) return true;

  if (!buildingFeatures?.length) return false;

  const { x, y } = project(lng, lat);
  for (const feature of buildingFeatures) {
    const rings = feature.geometry?.coordinates;
    if (!rings || !rings.length) continue;

    const projectedRings = rings.map((ring) =>
      ring.map(([ringLng, ringLat]) => {
        const p = project(ringLng, ringLat);
        return [p.x, p.y];
      }),
    );
    if (!isPointInPolygonWithHoles(x, y, projectedRings)) continue;

    // buildParcelGroupと同じ基準（建物footprint中心の地表面）で高さを判定する
    const height = Math.max(Number(feature.properties?.height) || 1, 0.1);
    const buildingTop = groundElevation + height;
    if (altitude >= groundElevation - BUILDING_BASE_MARGIN_METERS && altitude <= buildingTop) {
      return true;
    }
  }

  return false;
}
