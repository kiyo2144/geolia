import { redirect } from "next/navigation";

// 3Dマップはトップページ（/）に統合したため、/map への直接アクセス・
// 既存のブックマーク/リンクはトップページへ転送する。
export default function MapPage() {
  redirect("/");
}
