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
// 公開Overpass APIは混雑時に429(レート制限)・504(タイムアウト)を返すことがあり、
// 実機確認でも発生した。一時的な混雑であることが多いため、短い間隔で数回だけ
// リトライする（呼び出し側にエラーをそのまま伝えると、この間は常に「何も表示され
// ない」状態になってしまうため）。
const FETCH_RETRY_COUNT = 2;
const FETCH_RETRY_DELAY_MS = 1500;

// 道路の形状は交通量の値と違ってほぼ変化しないため、一度取得した範囲はしばらく
// キャッシュして使い回す（地図を行き来するたびにOverpass APIへ再リクエストするのを防ぐ）。
// bboxをこの単位（度）の格子に外側スナップしてからキャッシュキーにすることで、
// 少しのパン操作なら同じキャッシュがそのまま使える。
const GEOMETRY_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_GRID_DEGREES = 0.05;
const geometryCache = new Map(); // key -> { ways: Promise, expiresAt: number }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// bboxを含む最小の格子（CACHE_GRID_DEGREES四方）に外側スナップする
function snapBboxToGrid(bbox) {
  const grid = CACHE_GRID_DEGREES;
  return {
    minLng: Math.floor(bbox.minLng / grid) * grid,
    minLat: Math.floor(bbox.minLat / grid) * grid,
    maxLng: Math.ceil(bbox.maxLng / grid) * grid,
    maxLat: Math.ceil(bbox.maxLat / grid) * grid,
  };
}

function bboxCacheKey(bbox) {
  return `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`;
}

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

async function fetchRoadWaysFromOverpass(bbox) {
  const query = `[out:json][timeout:20];way[highway~"^(${HIGHWAY_TYPES})$"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});out geom;`;

  let lastError;
  for (let attempt = 0; attempt <= FETCH_RETRY_COUNT; attempt++) {
    if (attempt > 0) await sleep(FETCH_RETRY_DELAY_MS);
    try {
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`Overpass APIの取得に失敗しました: ${res.status}`);
      const data = await res.json();
      return (data.elements ?? [])
        .filter((el) => el.type === "way" && Array.isArray(el.geometry) && Array.isArray(el.nodes))
        .map((el) => ({
          id: el.id,
          nodeIds: el.nodes,
          tags: el.tags ?? {},
          coordinates: el.geometry.map((g) => [g.lon, g.lat]),
        }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * 指定範囲内の主要道路（線形状）をOverpass APIから取得する。
 * bbox: { minLng, minLat, maxLng, maxLat }
 * 戻り値: [{ id, nodeIds, tags, coordinates: [[lng,lat], ...] }, ...]
 * nodeIds（OSMのノードID列）は、隣接するway同士のつながりを判定するために使う
 * （区間の延長処理・buildHighlightedSegment参照）。
 *
 * bboxはCACHE_GRID_DEGREES単位の格子に外側スナップしてから取得・キャッシュするため、
 * 少しのパン操作であれば同じキャッシュ（GEOMETRY_CACHE_TTL_MSの間）が再利用される。
 */
export async function fetchNearbyRoadWays(bbox) {
  const snapped = snapBboxToGrid(bbox);
  const key = bboxCacheKey(snapped);
  const cached = geometryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ways;
  }

  const waysPromise = fetchRoadWaysFromOverpass(snapped);
  geometryCache.set(key, { ways: waysPromise, expiresAt: Date.now() + GEOMETRY_CACHE_TTL_MS });
  try {
    return await waysPromise;
  } catch (error) {
    geometryCache.delete(key); // 失敗した結果をキャッシュに残さない（次回また取得を試みられるように）
    throw error;
  }
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

// 2点間の直線距離（メートル、緯度経度の小さな範囲向けの平面近似）
function haversineApproxMeters(a, b) {
  const midLatRad = toRadians((a[1] + b[1]) / 2);
  const dx = toRadians(b[0] - a[0]) * EARTH_RADIUS_METERS * Math.cos(midLatRad);
  const dy = toRadians(b[1] - a[1]) * EARTH_RADIUS_METERS;
  return Math.hypot(dx, dy);
}

function wayLengthMeters(coordinates) {
  let total = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    total += haversineApproxMeters(coordinates[i], coordinates[i + 1]);
  }
  return total;
}

// 路線を識別するためのキー。ref（路線番号、例:"4"）を優先し、無ければname（路線名）を使う
function waySignature(way) {
  return way.tags?.ref ?? way.tags?.name ?? null;
}

/**
 * pointに最も近い道路線を起点に、同じ路線（ref/nameが一致）でノードがつながっている
 * 隣接 way を両端方向にたどって連結し、1本の長い区間として返す
 * （「区間の範囲」を、単一の短いway断片ではなく、ある程度の長さのまとまりとして
 * 表現するための処理。maxSegmentLengthMetersを超えたら延長を打ち切る）。
 * マッチする道路が無ければnullを返す。
 */
export function buildHighlightedSegment(point, ways, options = {}) {
  const { maxMatchDistanceMeters = 80, maxSegmentLengthMeters = 1500 } = options;

  const nearestWay = findNearestWay(point, ways, maxMatchDistanceMeters);
  if (!nearestWay) return null;

  let coordinates = [...nearestWay.coordinates];
  let startNode = nearestWay.nodeIds[0];
  let endNode = nearestWay.nodeIds[nearestWay.nodeIds.length - 1];
  const usedIds = new Set([nearestWay.id]);

  const signature = waySignature(nearestWay);
  if (signature) {
    const candidates = ways.filter((way) => way.id !== nearestWay.id && waySignature(way) === signature);
    let length = wayLengthMeters(coordinates);
    let extended = true;

    while (extended && length < maxSegmentLengthMeters) {
      extended = false;
      for (const way of candidates) {
        if (usedIds.has(way.id)) continue;
        const wayStartNode = way.nodeIds[0];
        const wayEndNode = way.nodeIds[way.nodeIds.length - 1];

        if (wayStartNode === endNode) {
          coordinates = coordinates.concat(way.coordinates.slice(1));
          endNode = wayEndNode;
        } else if (wayEndNode === endNode) {
          coordinates = coordinates.concat([...way.coordinates].reverse().slice(1));
          endNode = wayStartNode;
        } else if (wayEndNode === startNode) {
          coordinates = way.coordinates.slice(0, -1).concat(coordinates);
          startNode = wayStartNode;
        } else if (wayStartNode === startNode) {
          coordinates = [...way.coordinates].reverse().slice(0, -1).concat(coordinates);
          startNode = wayEndNode;
        } else {
          continue;
        }

        usedIds.add(way.id);
        length += wayLengthMeters(way.coordinates);
        extended = true;
        break;
      }
    }
  }

  return { coordinates, matchedWayId: nearestWay.id };
}
