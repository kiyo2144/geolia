"use client";

import dynamic from "next/dynamic";

const PlacementDetailView = dynamic(
  () => import("./PlacementDetailView").then((mod) => mod.PlacementDetailView),
  {
    ssr: false,
    loading: () => <p style={{ padding: 24 }}>配置情報を読み込んでいます...</p>,
  },
);

export default function PlacementDetailLoader({ id }) {
  return <PlacementDetailView id={id} />;
}
