/**
 * シード値から決定論的な疑似乱数列を生成する（mulberry32）。
 * Math.random() のような副作用のある呼び出しをレンダー中に行わずに済むようにするため、
 * デモ用の点群生成など「純粋関数として扱いたい乱数っぽい値」が必要な場面で使う。
 */
export function createSeededRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
