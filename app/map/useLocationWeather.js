"use client";

import { useEffect, useState } from "react";

// 天候の分類（Open-MeteoのWMO天気コード準拠）。
// https://open-meteo.com/en/docs のcurrent=weather_codeが返す値。
// 積雪系のコードは、空の表現としては曇り空に近いため「曇り」に含める。
function classifyWeatherCode(code) {
  if (code === 0 || code === 1) return "sunny";
  if ([2, 3, 45, 48, 71, 73, 75, 77, 85, 86].includes(code)) return "cloudy";
  return "rainy"; // 51-67(霧雨・雨)、80-82(にわか雨)、95-99(雷雨) 等
}

function toMinutesOfDay(isoLocalTime) {
  const timePart = isoLocalTime.split("T")[1];
  const [hour, minute] = timePart.split(":").map(Number);
  return hour * 60 + minute;
}

// 日の出から何分間を「朝」とみなすか
const MORNING_WINDOW_MINUTES = 120;

function classifyTimeOfDay(currentTime, sunrise, sunset) {
  const now = toMinutesOfDay(currentTime);
  const sunriseMin = toMinutesOfDay(sunrise);
  const sunsetMin = toMinutesOfDay(sunset);
  if (now >= sunriseMin && now < sunriseMin + MORNING_WINDOW_MINUTES) return "morning";
  if (now >= sunriseMin + MORNING_WINDOW_MINUTES && now < sunsetMin) return "day";
  return "night";
}

/**
 * 指定した緯度経度における現在の天候・時間帯を取得する。
 * Open-Meteo（APIキー不要）を使用。一人称視点（FirstPersonView）の空の
 * 表現に反映する。取得に失敗した場合は「昼・晴れ」を既定値として扱う。
 */
export function useLocationWeather(lat, lng) {
  const [state, setState] = useState({ timeOfDay: "day", weatherType: "sunny", loading: true });

  useEffect(() => {
    if (lat == null || lng == null) return;
    let cancelled = false;

    (async () => {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=weather_code&daily=sunrise,sunset&timezone=auto`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`weather fetch failed: ${response.status}`);
        const data = await response.json();

        const weatherType = classifyWeatherCode(data.current.weather_code);
        const timeOfDay = classifyTimeOfDay(data.current.time, data.daily.sunrise[0], data.daily.sunset[0]);

        if (!cancelled) setState({ timeOfDay, weatherType, loading: false });
      } catch (error) {
        console.error("天候データの取得に失敗しました:", error);
        if (!cancelled) setState({ timeOfDay: "day", weatherType: "sunny", loading: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  return state;
}
