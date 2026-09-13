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
          スマートフォンのカメラ、またはPCから3Dマップ上で、点群・Gaussian
          Splat・画像/GIF・VRM（モーション付き）などの3Dコンテンツを、現実の緯度・経度・高度に「設置」して共有できるプラットフォームです。
          設置したコンテンツは3Dマップ上にピンとして表示され、他のユーザーも同じ場所を訪れてARで、あるいはその場に行かずに3Dマップ・PCから閲覧できます。
        </p>
        <div className={styles.actions}>
          <Link href="/" className={styles.primaryAction}>
            地図を見る
          </Link>
          <Link href="/ar/new" className={styles.secondaryAction}>
            ARを設置する
          </Link>
        </div>
      </section>

      <section className={styles.features}>
        <div className={styles.featureCard}>
          <h2>AR設置</h2>
          <p>
            スマートフォンのカメラでGPS・コンパスを使って狙いを定め、点群・Gaussian
            Splat・画像/GIF・VRM（定型モーションまたはアップロードしたモーションファイル）を現実の場所に配置します。回転・高さ・拡大縮小を指で微調整して投稿できます。
          </p>
        </div>
        <div className={styles.featureCard}>
          <h2>デスクトップからの設置</h2>
          <p>
            現地に行かなくても、PCから3Dマップ上の任意の地点をクリックして一人称視点に入り、マウス操作でAR配置の新規設置・編集ができます。
          </p>
        </div>
        <div className={styles.featureCard}>
          <h2>3Dマップ</h2>
          <p>
            設置されたAR配置をピンとして一覧表示し、クリックすると3Dプレビューを確認できます。森林簿・地籍・OSM建物・道路交通量（JARTIC、5分ごと）・地形の起伏（標高タイル）などのデータも重ねて表示できます。
          </p>
        </div>
        <div className={styles.featureCard}>
          <h2>ARビュー</h2>
          <p>
            スマートフォンのカメラで周辺（半径300m）のAR配置を検出し、実際の景色に重ねて表示します。近くに配置があると、レーダーとコンパスで方向を知らせます。
          </p>
        </div>
        <div className={styles.featureCard}>
          <h2>配置一覧</h2>
          <p>投稿されたAR配置をサムネイル付きで一覧表示し、名前で検索できます。</p>
        </div>
        <div className={styles.featureCard}>
          <h2>データセット（準備中）</h2>
          <p>
            シェープファイルやGeoJSON形式の地理データをアップロードし、マップ上に追加できる機能を準備中です。
          </p>
        </div>
      </section>
    </main>
  );
}
