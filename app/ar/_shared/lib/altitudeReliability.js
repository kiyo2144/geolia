// GPS高度が信用できるかどうかを、標高タイル(DEM)との実際のズレの大きさから判定する。
// AR設置・AR閲覧の両画面で共通の考え方を使うため、ここにまとめている。
//
// 自己申告の精度(accuracy)・高度のブレ(altitudeJitter)が良好な値を返しているのに、
// 実際の高度が標高タイルと数十m単位でズレる端末があることが実機確認で分かった
// （屋内、特にコンクリート造の建物内で顕著）。そのため自己申告の精度ではなく、
// 標高タイルとの実際のズレの大きさそのものを見て判定する。

// GPS高度が標高タイルより「上」にズレている場合の閾値(メートル)。実機確認では
// 屋外で1m未満〜屋内で数十m(最大約50m)のズレが見られており、通常の設置(地上付近)
// では起こりにくい大きさとして間を取った値にしている。上方向は高い建物の上層階など
// 正当なケースもあり得るため、下方向より緩めにしている。
export const ALTITUDE_ABOVE_TERRAIN_MISMATCH_THRESHOLD_METERS = 15;

// GPS高度が標高タイルより「下」にズレている場合の閾値(メートル)。屋外の地表で
// GPS高度が標高タイルより数m以上低く出ることは通常あり得ない(地面に埋まっている
// ことになってしまう)ため、上方向より小さい値で信頼できないと判定する。
export const ALTITUDE_BELOW_TERRAIN_MISMATCH_THRESHOLD_METERS = 3;

// GPS高度が信用できないと判断したときに、代わりに使う「地面から持ち上げて構えている
// 高さ」の目安（人がスマホを構える高さの概算）。
export const ASSUMED_HAND_HEIGHT_METERS = 1;

// rawAltitude(GPSが報告する高度)と groundElevation(標高タイルの高度)から、
// GPS高度が信用できないほど食い違っているかどうかを判定する。
// どちらかがnull/undefinedの場合は判定できないためfalseを返す。
export function isAltitudeUnreliable(rawAltitude, groundElevation) {
  if (rawAltitude === null || rawAltitude === undefined) return false;
  if (groundElevation === null || groundElevation === undefined) return false;

  const rawGroundLocalY = groundElevation - rawAltitude;
  return (
    rawGroundLocalY > ALTITUDE_BELOW_TERRAIN_MISMATCH_THRESHOLD_METERS ||
    rawGroundLocalY < -ALTITUDE_ABOVE_TERRAIN_MISMATCH_THRESHOLD_METERS
  );
}

// 実際の計算に使うべき高度。GPS高度が信用できる場合はそのまま、信用できない場合は
// 「標高タイルの地面 + 人がスマホを構える高さの目安」を代わりに返す。
// groundElevationが未取得(null)の場合は、判定できないためrawAltitudeをそのまま返す。
export function getEffectiveAltitude(rawAltitude, groundElevation) {
  if (rawAltitude === null || rawAltitude === undefined) return null;
  if (groundElevation === null || groundElevation === undefined) return rawAltitude;

  return isAltitudeUnreliable(rawAltitude, groundElevation)
    ? groundElevation + ASSUMED_HAND_HEIGHT_METERS
    : rawAltitude;
}
