"use client";

import { DECORATION_OPTIONS, IMAGE_EFFECT_OPTIONS } from "../ar/_shared/lib/dataFormat";
import { ThumbnailPreviewCapture } from "../ar/_shared/components/ThumbnailPreviewCapture";
import styles from "./DesktopArPlacementPanel.module.css";

function LivePositionReadout({ livePosition, styles: cssStyles }) {
  if (!livePosition) return null;
  return (
    <p className={cssStyles.hint}>
      緯度 {livePosition.lat.toFixed(6)} / 経度 {livePosition.lng.toFixed(6)} / 標高 約
      {livePosition.altitude.toFixed(1)}m
    </p>
  );
}

/**
 * 一人称視点画面から、カメラを使わずにマップ上の位置・標高を基準にAR配置を
 * 新規登録するための2Dオーバーレイパネル。実際の3Dプレビューは
 * DesktopArPlacementPreview（Canvas内）が担当する。
 */
export function DesktopArPlacementPanel({ placement }) {
  const {
    close,
    step,
    dataFile,
    dataFormat,
    splatFileType,
    dataUrl,
    fileError,
    handleFileChange,
    proceedToAiming,
    aimLngLat,
    confirmPosition,
    backToAiming,
    backToSelect,
    backToAdjust,
    adjustment,
    isAdjustMode,
    setIsAdjustMode,
    rotate,
    changeScale,
    changeHeight,
    flipVertical,
    resetAdjustment,
    proceedToPost,
    previewBlob,
    setPreviewBlob,
    decorationPresetKey,
    setDecorationPresetKey,
    imageEffectKey,
    setImageEffectKey,
    finalAltitude,
    livePosition,
    label,
    setLabel,
    labelError,
    isSaving,
    saveStatus,
    save,
  } = placement;

  const isImageLike = dataFormat === "image" || dataFormat === "gif";

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h3>AR設置（カメラなし）</h3>
        <button type="button" className={styles.closeButton} onClick={close}>
          閉じる
        </button>
      </div>

      {step === "select" && (
        <div className={styles.body}>
          <p className={styles.hint}>
            点群（.ply）、Gaussian Splat（.spz/.splat/.ksplat/.sog）、静止画・GIF、VRM（.vrm）
            から選択してください。
          </p>
          <label className={styles.fileLabel}>
            ファイルを選択
            <input
              type="file"
              accept=".ply,.spz,.splat,.ksplat,.sog,.jpg,.jpeg,.png,.webp,.gif,.vrm"
              onChange={handleFileChange}
            />
          </label>
          {fileError && <p className={styles.error}>{fileError}</p>}
          {dataFile && <p className={styles.hint}>選択中: {dataFile.name}</p>}

          {isImageLike && (
            <>
              <p className={styles.hint}>装飾フレーム</p>
              <div className={styles.actions}>
                {DECORATION_OPTIONS.map((option) => (
                  <label key={option.value} className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="decorationPreset"
                      value={option.value}
                      checked={decorationPresetKey === option.value}
                      onChange={() => setDecorationPresetKey(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              <p className={styles.hint}>エフェクト</p>
              <div className={styles.actions}>
                {IMAGE_EFFECT_OPTIONS.map((option) => (
                  <label key={option.value} className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="imageEffect"
                      value={option.value}
                      checked={imageEffectKey === option.value}
                      onChange={() => setImageEffectKey(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </>
          )}

          {dataUrl && (dataFormat === "splat" || dataFormat === "ply" || dataFormat === "vrm") && (
            <>
              <p className={styles.hint}>サムネイル（配置一覧などに表示される画像）</p>
              <ThumbnailPreviewCapture
                dataFormat={dataFormat}
                dataUrl={dataUrl}
                splatFileType={splatFileType}
                onCapture={setPreviewBlob}
              />
              <p className={styles.hint}>{previewBlob ? "撮影済み" : "まだ撮影されていません（未撮影でも投稿できます）"}</p>
            </>
          )}

          <button type="button" className={styles.primaryButton} onClick={proceedToAiming} disabled={!dataFile}>
            位置を選ぶ
          </button>
        </div>
      )}

      {step === "aiming" && (
        <div className={styles.body}>
          <p className={styles.hint}>
            W/A/S/Dまたは画面下部のボタンで歩いて正面のプレビューを合わせるか、
            右上のサブマップをクリックして設置したい地点を選んでください。
          </p>
          {aimLngLat && <p className={styles.hint}>サブマップで地点を選択済みです</p>}
          <LivePositionReadout livePosition={livePosition} styles={styles} />
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={backToSelect}>
              ← 戻る
            </button>
            <button type="button" className={styles.primaryButton} onClick={confirmPosition}>
              ここに設置
            </button>
          </div>
        </div>
      )}

      {step === "adjust" && (
        <div className={styles.body}>
          <p className={styles.hint}>
            標高タイルの高度を基準に高度 約{finalAltitude !== null ? finalAltitude.toFixed(1) : "-"}m
          </p>
          <LivePositionReadout livePosition={livePosition} styles={styles} />

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
            <button type="button" className={styles.secondaryButton} onClick={backToAiming}>
              ← 位置をやり直す
            </button>
            <button type="button" className={styles.primaryButton} onClick={proceedToPost}>
              次へ（投稿内容を入力）
            </button>
          </div>
        </div>
      )}

      {step === "post" && (
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
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={backToAdjust}>
              ← 戻る
            </button>
            <button type="button" className={styles.primaryButton} onClick={save} disabled={isSaving}>
              {isSaving ? "シェア中..." : "シェア"}
            </button>
          </div>
          {saveStatus && (
            <p className={saveStatus === "シェアしました" ? styles.statusSuccess : styles.hint}>{saveStatus}</p>
          )}
        </div>
      )}
    </div>
  );
}
