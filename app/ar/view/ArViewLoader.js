"use client";

import dynamic from "next/dynamic";

const ArViewView = dynamic(() => import("./ArViewView").then((mod) => mod.ArViewView), {
  ssr: false,
  loading: () => <p style={{ padding: 24 }}>AR閲覧機能を読み込んでいます...</p>,
});

export default function ArViewLoader() {
  return <ArViewView />;
}
