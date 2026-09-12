import Link from "next/link";
import styles from "./page.module.css";

export const metadata = {
  title: "About | geolia",
};

export default function AboutPage() {
  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <h1 className={styles.title}>geolia</h1>
        <p className={styles.lead}>
          スマートフォンのカメラを使って、点群・Gaussian
          Splat・画像・VRoidStudioデータなどの3Dコンテンツを、現実の緯度・経度・高度に「設置」して共有できるプラットフォームです。
          設置した3Dデータは3Dマップ上に可視化され、他のユーザーも同じ場所を訪れてARで閲覧できます。
        </p>
        <div className={styles.actions}>
          <Link href="/" className={styles.primaryAction}>
            地図を見る
          </Link>
          <Link href="/ar/new" className={styles.secondaryAction}>
            ARで設置する
          </Link>
        </div>
      </section>

      <section className={styles.features}>
        <div className={styles.featureCard}>
          <h2>AR設置</h2>
          <p>
            カメラ・位置情報・端末の向きを使い、3Dデータを現実の場所に配置します。設置した内容はSupabaseに保存され、他のユーザーとも共有されます。
          </p>
        </div>
        <div className={styles.featureCard}>
          <h2>3Dマップ</h2>
          <p>
            設置済みのデータを地図上にピンとして一覧表示します。森林簿・地籍などのサンプル地理データや、ユーザーが追加したデータも重ねて表示できます。
          </p>
        </div>
        <div className={styles.featureCard}>
          <h2>データセット</h2>
          <p>
            シェープファイルやGeoJSON形式の地理データをアップロードし、マップ上に追加できます。
          </p>
        </div>
      </section>
    </main>
  );
}
