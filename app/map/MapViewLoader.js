"use client";

import dynamic from "next/dynamic";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <p style={{ padding: 24 }}>地図を読み込んでいます...</p>,
});

export default function MapViewLoader() {
  return <MapView />;
}
