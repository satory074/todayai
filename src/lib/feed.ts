/** 全情報源を統一する正規化済みフィードアイテム。 */
export type FeedSource = "x" | "feedly" | "hatena" | "layerx";

export interface FeedItem {
  /** 一意キー（X: tweet id / Feedly: item id / はてブ: entry url） */
  id: string;
  source: FeedSource;
  /** X は本文先頭、その他は記事タイトル */
  title: string;
  /** 外部リンク（新規タブで開く） */
  url: string;
  /** ISO 8601 */
  publishedAt: string;
  summary?: string;
  thumbnail?: string;
  /** X の screen name / 記事の配信元サイト名 */
  author?: string;
  /** はてブのブックマーク数 */
  bookmarkCount?: number;
}

/** aggregate.ts が書き出す feed.json のトップレベル構造。 */
export interface FeedData {
  /** 最終更新時刻 ISO 8601 */
  updatedAt: string;
  items: FeedItem[];
  /** ソースごとの状態（X 外部アカウントの since_id 等） */
  state?: {
    /** 外部アカウント username -> 前回取得済み最新ツイートID（since_id＝重複課金回避） */
    xAccountSinceIds?: Record<string, string>;
    /** 外部アカウント username -> userId の解決結果キャッシュ */
    xAccountUserIds?: Record<string, string>;
    /** X ブックマーク等 tweet id(`x-<id>`) -> OGP画像URL / ""(確認済み・画像なし) */
    xOgImages?: Record<string, string>;
    /** LayerX トピック id(`layerx-<uuid>`) -> OGP画像URL / ""(確認済み・画像なし) */
    layerxOgImages?: Record<string, string>;
  };
}

export interface SourceMeta {
  key: FeedSource;
  label: string;
  /** Tailwind 用のアクセントクラス（バッジ等） */
  badgeClass: string;
}

export const SOURCES: SourceMeta[] = [
  { key: "x", label: "X", badgeClass: "src-x" },
  { key: "feedly", label: "Feedly", badgeClass: "src-feedly" },
  { key: "hatena", label: "はてブ", badgeClass: "src-hatena" },
  { key: "layerx", label: "LayerX", badgeClass: "src-layerx" },
];

export function sourceLabel(source: FeedSource): string {
  return SOURCES.find((s) => s.key === source)?.label ?? source;
}

/** 相対時刻（"3分前" / "2時間前" / "5日前" / 日付）。 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.floor((now.getTime() - then) / 1000);
  if (diffSec < 60) return "たった今";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}日前`;
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 絶対時刻（X 埋め込み風"14:32 · 2026年6月7日"）。 */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  const date = d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
  return `${time} · ${date}`;
}

// ===== X 由来アイテムのアバター/著者表示ヘルパー =====

/** X の author は "@handle"（自投稿・外部アカウント）か カテゴリラベル（いいね/ブックマーク/投稿）。 */
export interface XAuthor {
  kind: "handle" | "category";
  /** kind="handle" のとき "@" を除いたハンドル名 */
  handle?: string;
  /** kind="category" のときの表示ラベル（"いいねした投稿" 等） */
  label?: string;
}

const CATEGORY_DISPLAY: Record<string, string> = {
  いいね: "いいねした投稿",
  ブックマーク: "ブックマークした投稿",
  投稿: "投稿",
};

export function parseXAuthor(author?: string): XAuthor {
  const a = (author ?? "").trim();
  if (a.startsWith("@")) return { kind: "handle", handle: a.slice(1) };
  return { kind: "category", label: CATEGORY_DISPLAY[a] ?? a ?? "投稿" };
}

/** seed 文字列から表示用イニシャル（日本語1字 / 英数2字）。 */
export function avatarInitials(seed: string): string {
  const s = seed.replace(/^@+/, "").replace(/[^\p{L}\p{N}]/gu, "");
  if (!s) return "X";
  // 英数なら2字、それ以外（日本語等）は先頭1字
  if (/^[A-Za-z0-9]/.test(s)) return s.slice(0, 2).toUpperCase();
  return [...s][0];
}

/** seed 文字列をハッシュした安定色（HSL）。同じハンドルは常に同じ色。 */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 55% 45%)`;
}

/** 日付ヘッダ用のキー（"2026-06-03"）。 */
export function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** 日付ヘッダの表示（"今日" / "昨日" / "6月1日 (月)"）。 */
export function dayLabel(key: string, now: Date = new Date()): string {
  const todayKey = now.toISOString().slice(0, 10);
  const yest = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  if (key === todayKey) return "今日";
  if (key === yest) return "昨日";
  const d = new Date(key + "T00:00:00");
  return d.toLocaleDateString("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}
