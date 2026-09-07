"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PlacementLocationMap } from "../../_shared/components/PlacementLocationMap";
import styles from "./PlacementDetailView.module.css";

function formatDateTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function assetTypeLabel(assetType) {
  return assetType === "gaussian_splat" ? "Gaussian Splat" : "点群";
}

export function PlacementDetailView({ id }) {
  const supabase = useMemo(() => createClient(), []);
  const [placement, setPlacement] = useState(undefined); // undefined=読込中, null=見つからない
  const [error, setError] = useState(null);

  useEffect(() => {
    let isCancelled = false;

    supabase
      .from("ar_placements")
      .select(
        "id, label, lat, lng, altitude, created_at, preview_storage_path, ar_data_assets(asset_type, format, original_filename)",
      )
      .eq("id", id)
      .maybeSingle()
      .then(({ data, error: fetchError }) => {
        if (isCancelled) return;
        if (fetchError) {
          setError(fetchError.message);
          return;
        }
        setPlacement(data);
      });

    return () => {
      isCancelled = true;
    };
  }, [id, supabase]);

  const previewUrl =
    placement?.preview_storage_path &&
    supabase.storage.from("ar-assets").getPublicUrl(placement.preview_storage_path).data.publicUrl;

  return (
    <div className={styles.wrapper}>
      <Link href="/placements" className={styles.backLink}>
        ← 配置一覧に戻る
      </Link>

      {error && <p className={styles.error}>読み込みに失敗しました: {error}</p>}

      {placement === undefined && !error && <p className={styles.hint}>読み込み中...</p>}

      {placement === null && !error && (
        <p className={styles.hint}>指定された配置が見つかりませんでした。</p>
      )}

      {placement && (
        <>
          <h1 className={styles.title}>{placement.label ?? "（名前なし）"}</h1>

          {previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="設置プレビュー" className={styles.previewImage} />
          )}

          <PlacementLocationMap targetPosition={{ lat: placement.lat, lng: placement.lng }} />

          <dl className={styles.detailList}>
            <dt>緯度・経度</dt>
            <dd>
              {placement.lat.toFixed(6)}, {placement.lng.toFixed(6)}
            </dd>

            <dt>高度</dt>
            <dd>{placement.altitude === null ? "取得できませんでした" : `約${placement.altitude.toFixed(1)}m`}</dd>

            <dt>データ形式</dt>
            <dd>
              {assetTypeLabel(placement.ar_data_assets?.asset_type)}（{placement.ar_data_assets?.format}）
            </dd>

            <dt>登録日時</dt>
            <dd>{formatDateTime(placement.created_at)}</dd>
          </dl>

          <div className={styles.actions}>
            <Link href="/ar/view" className={styles.arViewButton}>
              ARで見る
            </Link>
            <p className={styles.hint}>
              この場所の近く（半径300m以内）にいるときに「AR閲覧」で表示されます。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
