// 【実験的機能】JARTIC交通量の観測地点（点）を、実際の道路の形状（線）に
// おおよそ対応づけて表示するための処理。
//
// JARTICの観測点コードと道路の区間形状を直接つなぐ公式なIDは存在しないため
// （「国土数値情報 道路データ(N13)」「箇所別基本表」のいずれにも、JARTICの
// 観測点コードと紐づく識別子は含まれていない）、ここでは観測点に最も近い
// OpenStreetMapの道路線を「推定の対応区間」として採用する近似処理を行っている。
// そのため、実際の調査区間の境界とは異なる場合がある（呼び出し側でユーザーに
// 明示すること）。
//
// 道路の形状データ自体は、CORS対応済みのOverpass APIから直接取得する
// （国土数値情報の道路データは都道府県単位のダウンロード配布のみで、
// bbox単位のライブ取得ができないため採用を見送った）。

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// JARTICの観測対象（高速自動車国道・一般国道）におおむね対応する道路種別のみに絞る
const HIGHWAY_TYPES = "motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link";
const EARTH_RADIUS_METERS = 6378137;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

// origin を基準にした東西(x)・南北(y)のローカル平面座標（メートル）に変換する
// （app/_shared/lib/geoMath.js の latLngToLocalMeters と同じ考え方の簡易版）
function toLocalMeters(origin, point) {
  const deltaLatRad = toRadians(point.lat - origin.lat);
  const deltaLngRad = toRadians(point.lng - origin.lng);
  const averageLatRad = toRadians((origin.lat + point.lat) / 2);
  return {
    x: deltaLngRad * EARTH_RADIUS_METERS * Math.cos(averageLatRad),
    y: deltaLatRad * EARTH_RADIUS_METERS,
  };
}

/**
 * 指定範囲内の主要道路（線形状）をOverpass APIから取得する。
 * bbox: { minLng, minLat, maxLng, maxLat }
 * 戻り値: [{ id, coordinates: [[lng,lat], ...] }, ...]
 */
export async function fetchNearbyRoadWays(bbox) {
  const query = `[out:json][timeout:20];way[highway~"^(${HIGHWAY_TYPES})$"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});out geom;`;
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass APIの取得に失敗しました: ${res.status}`);
  const data = await res.json();
  return (data.elements ?? [])
    .filter((el) => el.type === "way" && Array.isArray(el.geometry))
    .map((el) => ({
      id: el.id,
      coordinates: el.geometry.map((g) => [g.lon, g.lat]),
    }));
}

// 点pointから線分(a-b)までの最短距離（メートル）を求める（origin基準のローカル平面近似）
function distancePointToSegmentMeters(origin, point, a, b) {
  const p = toLocalMeters(origin, point);
  const va = toLocalMeters(origin, a);
  const vb = toLocalMeters(origin, b);
  const dx = vb.x - va.x;
  const dy = vb.y - va.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(p.x - va.x, p.y - va.y);
  }
  const t = Math.max(0, Math.min(1, ((p.x - va.x) * dx + (p.y - va.y) * dy) / lengthSquared));
  const closestX = va.x + t * dx;
  const closestY = va.y + t * dy;
  return Math.hypot(p.x - closestX, p.y - closestY);
}

/**
 * pointに最も近い道路線をwaysの中から探す。maxDistanceMeters以内に見つからなければnullを返す
 * （無関係な道路に誤って対応づけないための安全策）。
 */
export function findNearestWay(point, ways, maxDistanceMeters) {
  let nearest = null;
  let nearestDistance = Infinity;

  for (const way of ways) {
    for (let i = 0; i < way.coordinates.length - 1; i++) {
      const [lngA, latA] = way.coordinates[i];
      const [lngB, latB] = way.coordinates[i + 1];
      const distance = distancePointToSegmentMeters(
        point,
        point,
        { lat: latA, lng: lngA },
        { lat: latB, lng: lngB },
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = way;
      }
    }
  }

  return nearestDistance <= maxDistanceMeters ? nearest : null;
}
