"use client";

import dynamic from "next/dynamic";

const ArNewView = dynamic(() => import("./ArNewView").then((mod) => mod.ArNewView), {
  ssr: false,
  loading: () => <p style={{ padding: 24 }}>AR設置機能を読み込んでいます...</p>,
});

export default function ArNewLoader() {
  return <ArNewView />;
}
