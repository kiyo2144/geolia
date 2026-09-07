import styles from "./PlaceholderPage.module.css";

export function PlaceholderPage({ title, description }) {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
      <p className={styles.note}>この画面は準備中です。</p>
    </main>
  );
}
