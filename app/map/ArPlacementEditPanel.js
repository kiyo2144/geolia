"use client";

import styles from "./ArPlacementEditPanel.module.css";

/**
 * 一人称視点画面で、既存のAR配置をその場で編集するための2Dオーバーレイパネル。
 * 実際のライブプレビューは、FirstPersonView側でDetailedPlacementの表示に
 * 編集中の調整値をそのまま反映することで実現している（専用のプレビューは持たない）。
 */
export function ArPlacementEditPanel({ edit }) {
  const {
    editingPlacement,
    close,
    label,
    setLabel,
    labelError,
    isAdjustMode,
    setIsAdjustMode,
    rotate,
    changeScale,
    changeHeight,
    flipVertical,
    resetAdjustment,
    isSaving,
    saveStatus,
    save,
  } = edit;

  if (!editingPlacement) return null;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h3>AR配置を編集</h3>
        <button type="button" className={styles.closeButton} onClick={close}>
          閉じる
        </button>
      </div>

      <div className={styles.body}>
        <label className={styles.field}>
          名前
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className={labelError ? styles.inputError : ""}
          />
        </label>

        <button
          type="button"
          className={isAdjustMode ? styles.toggleButtonActive : styles.toggleButton}
          onClick={() => setIsAdjustMode((current) => !current)}
        >
          ドラッグで調整: {isAdjustMode ? "ON" : "OFF"}
        </button>
        {isAdjustMode && (
          <p className={styles.hint}>横ドラッグ=回転 ・ 縦ドラッグ=高さ ・ ホイール=拡大縮小</p>
        )}

        <div className={styles.adjustGrid}>
          <span>回転</span>
          <div className={styles.actions}>
            <button type="button" onClick={() => rotate(-1)}>
              ◀
            </button>
            <button type="button" onClick={() => rotate(1)}>
              ▶
            </button>
          </div>

          <span>高さ</span>
          <div className={styles.actions}>
            <button type="button" onClick={() => changeHeight(-1)}>
              －
            </button>
            <button type="button" onClick={() => changeHeight(1)}>
              ＋
            </button>
          </div>

          <span>拡大縮小</span>
          <div className={styles.actions}>
            <button type="button" onClick={() => changeScale(-1)}>
              －
            </button>
            <button type="button" onClick={() => changeScale(1)}>
              ＋
            </button>
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" onClick={flipVertical}>
            上下反転
          </button>
          <button type="button" onClick={resetAdjustment}>
            調整をリセット
          </button>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.primaryButton} onClick={save} disabled={isSaving}>
            {isSaving ? "更新中..." : "更新を保存"}
          </button>
        </div>
        {saveStatus && (
          <p className={saveStatus === "更新しました" ? styles.statusSuccess : styles.hint}>{saveStatus}</p>
        )}
      </div>
    </div>
  );
}
