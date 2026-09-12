"use client";

import { useState } from "react";
import { ArPopupModelPreview } from "./ArPopupModelPreview";
import styles from "./ArPlacementPopupContent.module.css";

const MODEL_ASSET_TYPES = new Set(["gaussian_splat", "point_cloud", "vrm"]);

function assetTypeLabel(assetType) {
  if (assetType === "gaussian_splat") return "Gaussian Splat";
  if (assetType === "vrm") return "VRM";
  if (assetType === "image") return "画像";
  if (assetType === "gif") return "GIF";
  return "点群";
}

/**
 * 3Dマップ上のAR配置ピンをクリックした際に表示する詳細ポップアップの中身。
 * MapView側でMapLibreのPopup（setDOMContent）にReactポータルとして描画される。
 */
export function ArPlacementPopupContent({ placement, previewUrl, dataUrl, motionAssetUrl, onDeleted }) {
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [password, setPassword] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const altitudeText =
    placement.altitude === null || placement.altitude === undefined
      ? "高度情報なし"
      : `高度 約${Math.round(placement.altitude)}m`;

  const handleDelete = async () => {
    setIsDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch("/api/admin/delete-placement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placementId: placement.id, password }),
      });
      const body = await res.json();
      if (!res.ok) {
        setDeleteError(body.error ?? "削除に失敗しました");
        return;
      }
      onDeleted?.(placement.id);
    } catch {
      setDeleteError("通信に失敗しました");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className={styles.wrapper}>
      {MODEL_ASSET_TYPES.has(placement.asset_type) && dataUrl ? (
        <ArPopupModelPreview
          assetType={placement.asset_type}
          url={dataUrl}
          motionPresetKey={placement.motion_preset_key}
          motionAssetUrl={motionAssetUrl}
        />
      ) : (
        previewUrl && <img src={previewUrl} alt="設置プレビュー" className={styles.previewImage} />
      )}

      <b>{placement.label ?? "AR配置"}</b>
      <br />
      種別 {assetTypeLabel(placement.asset_type)}（{placement.format}）
      <br />
      {altitudeText}

      <div className={styles.actions}>
        {!isDeleteMode ? (
          <button type="button" className={styles.deleteButton} onClick={() => setIsDeleteMode(true)}>
            削除
          </button>
        ) : (
          <div className={styles.deleteConfirm}>
            <input
              type="password"
              placeholder="管理者パスワード"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={styles.passwordInput}
            />
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.deleteButton}
                onClick={handleDelete}
                disabled={isDeleting || !password}
              >
                {isDeleting ? "削除中..." : "削除を確定"}
              </button>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={() => {
                  setIsDeleteMode(false);
                  setPassword("");
                  setDeleteError("");
                }}
                disabled={isDeleting}
              >
                キャンセル
              </button>
            </div>
            {deleteError && <p className={styles.error}>{deleteError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
