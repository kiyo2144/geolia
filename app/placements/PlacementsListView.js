"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./PlacementsListView.module.css";

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

export function PlacementsListView() {
  const supabase = useMemo(() => createClient(), []);
  const [placements, setPlacements] = useState(null);
  const [error, setError] = useState(null);
  const [searchText, setSearchText] = useState("");

  useEffect(() => {
    let isCancelled = false;

    supabase
      .from("ar_placements")
      .select("id, label, created_at, preview_storage_path, ar_data_assets(asset_type, format)")
      .order("created_at", { ascending: false })
      .then(({ data, error: fetchError }) => {
        if (isCancelled) return;
        if (fetchError) {
          setError(fetchError.message);
          return;
        }
        setPlacements(data);
      });

    return () => {
      isCancelled = true;
    };
  }, [supabase]);

  const filteredPlacements = useMemo(() => {
    if (!placements) return null;
    const keyword = searchText.trim().toLowerCase();
    if (!keyword) return placements;
    return placements.filter((placement) => placement.label?.toLowerCase().includes(keyword));
  }, [placements, searchText]);

  return (
    <div className={styles.wrapper}>
      <h1 className={styles.title}>配置一覧</h1>
      <p className={styles.hint}>保存済みのAR配置を一覧・検索できます。</p>

      <input
        type="text"
        className={styles.searchInput}
        placeholder="名前で検索"
        value={searchText}
        onChange={(event) => setSearchText(event.target.value)}
      />

      {error && <p className={styles.error}>読み込みに失敗しました: {error}</p>}

      {filteredPlacements === null && !error && <p className={styles.hint}>読み込み中...</p>}

      {filteredPlacements !== null && filteredPlacements.length === 0 && (
        <p className={styles.hint}>
          {placements.length === 0
            ? "まだAR配置がありません。「AR設置」から作成できます。"
            : "検索条件に一致する配置がありません。"}
        </p>
      )}

      {filteredPlacements !== null && filteredPlacements.length > 0 && (
        <ul className={styles.list}>
          {filteredPlacements.map((placement) => {
            const previewUrl = placement.preview_storage_path
              ? supabase.storage.from("ar-assets").getPublicUrl(placement.preview_storage_path)
                  .data.publicUrl
              : null;
            return (
              <li key={placement.id}>
                <Link href={`/placements/${placement.id}`} className={styles.card}>
                  <div className={styles.thumbnail}>
                    {previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previewUrl} alt="" className={styles.thumbnailImage} />
                    ) : (
                      <div className={styles.thumbnailPlaceholder} />
                    )}
                  </div>
                  <div className={styles.cardBody}>
                    <p className={styles.cardLabel}>{placement.label ?? "（名前なし）"}</p>
                    <p className={styles.cardMeta}>
                      {assetTypeLabel(placement.ar_data_assets?.asset_type)}（
                      {placement.ar_data_assets?.format}） ・ {formatDateTime(placement.created_at)}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
