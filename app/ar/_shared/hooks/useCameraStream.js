"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * リアカメラの映像ストリームを <video> 要素へ流すフック。
 * iOS Safari では getUserMedia もユーザー操作直後の呼び出しが必要。
 */
export function useCameraStream() {
  const videoRef = useRef(null);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState(null);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setIsActive(true);
      setError(null);
    } catch (cameraError) {
      setError(cameraError);
      setIsActive(false);
    }
  }, []);

  const stop = useCallback(() => {
    const stream = videoRef.current?.srcObject;
    stream?.getTracks?.().forEach((track) => track.stop());

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsActive(false);
  }, []);

  // 画面遷移などでコンポーネントがアンマウントされた際、カメラストリームを
  // 確実に止める（呼び出し側がstop()し忘れても、端末のカメラが使用中のままに
  // ならないようにする安全策）。
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      const stream = video?.srcObject;
      stream?.getTracks?.().forEach((track) => track.stop());
    };
  }, []);

  return { videoRef, start, stop, isActive, error };
}
