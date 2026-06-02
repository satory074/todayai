/** 全情報源を統一する正規化済みフィードアイテム。 */
export type FeedSource = "x" | "feedly" | "hatena";

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
  /** ソースごとの状態（X の since_id 等） */
  state?: {
    /** 前回取得済みの最新ツイートID（since_id に使う＝重複課金回避） */
    xLastSeenId?: string;
    /** username→id の解決結果キャッシュ */
    xUserId?: string;
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
