import Link from "next/link";
import styles from "./SiteHeader.module.css";

const NAV_LINKS = [
  { href: "/map", label: "マップ" },
  { href: "/placements", label: "配置一覧" },
  { href: "/datasets", label: "データセット" },
  { href: "/ar/new", label: "AR設置" },
  { href: "/ar/view", label: "AR閲覧" },
];

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          geolia
        </Link>
        <nav className={styles.nav}>
          {NAV_LINKS.map(({ href, label }) => (
            <Link key={href} href={href} className={styles.navLink}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
