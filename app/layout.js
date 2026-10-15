import { Geist, Geist_Mono } from "next/font/google";
import { PreventPageZoom } from "./components/PreventPageZoom";
import { SiteHeader } from "./components/SiteHeader";
import "./globals.css";

// デザイン方向性「森と光」（globals.css参照）の見出し・本文フォント。
const DESIGN_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Kaisei+Tokumin:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "geolia",
  description:
    "AR3Dデータを現実の位置に設置し、3Dマップ上で可視化・共有するプラットフォーム",
};

// ページ全体の拡大を禁止する。AR画面（カメラ全面表示）では、入力欄へのフォーカスや
// 意図しないピンチで画面が拡大されると、操作ボタンが画面外に出て使えなくなるため。
export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={DESIGN_FONTS_HREF} />
      </head>
      <body>
        <PreventPageZoom />
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
