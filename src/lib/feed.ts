/** 全情報源を統一する正規化済みフィードアイテム。 */
export type FeedSource = "x" | "zenn" | "qiita" | "hatena" | "layerx" | "workspace";

export interface FeedItem {
  /** 一意キー（X: tweet id / 記事系(zenn/qiita/workspace): 記事URL / はてブ: entry url） */
  id: string;
  source: FeedSource;
  /** X は本文先頭、その他は記事タイトル（原文） */
  title: string;
  /** 外部リンク（新規タブで開く） */
  url: string;
  /** ISO 8601 */
  publishedAt: string;
  summary?: string;
  /** title の日本語訳（原文が日本語なら未設定）。集約時に Gemini で補完。 */
  titleJa?: string;
  /** summary の日本語訳（原文が日本語 or summary 無しなら未設定）。 */
  summaryJa?: string;
  thumbnail?: string;
  /** X の screen name / 記事の配信元サイト名 */
  author?: string;
  /** X のプロフィール画像URL（_400x400 版）。集約時に syndication / X API で補完。 */
  avatarUrl?: string;
  /** X の表示名（@handle とは別。例 "NotebookLM"）。集約時に補完。 */
  authorName?: string;
  /** はてブのブックマーク数 */
  bookmarkCount?: number;
  /**
   * 集約中のみの一時フィールド。記事ページから抽出した本文プレーンテキスト（要約の入力に使う）。
   * `aggregate.ts` が feed.json 書き出し前に削除するので、永続化された feed.json には残らない。
   */
  contentText?: string;
}

/** X ツイートの著者メタ（syndication 解決結果のキャッシュ）。 */
export interface XAuthorMeta {
  /** 表示名 */
  name: string;
  /** screen name（@なし） */
  handle: string;
  /** プロフィール画像URL（_400x400 版）。無ければ未設定 */
  avatar?: string;
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
    /**
     * X item id(`x-<id>`) -> 著者メタ（syndication 解決）/ null(確認済み・著者なしの負キャッシュ)。
     * ブックマーク等で元ツイートの著者・アイコンを復元するための永続化。
     * fetch 失敗（transient/CIブロック）時は記録せず次回 run で再試行する。
     */
    xAuthors?: Record<string, XAuthorMeta | null>;
    /** X以外（zenn/qiita/hatena/workspace）item id -> OGP画像URL / ""(確認済み・画像なし) */
    ogImages?: Record<string, string>;
    /**
     * item id -> 翻訳/要約キャッシュ（毎回フレッシュ取得されるソースでも再翻訳しないための永続化）。
     * titleJa は原文が日本語なら未設定、summaryJa は記事系=3行要約 / その他=翻訳。
     */
    translations?: Record<string, { titleJa?: string; summaryJa?: string }>;
    /** translations の生成ロジック版。ENRICH_VERSION と不一致なら作り直す。 */
    enrichVersion?: string;
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
  { key: "hatena", label: "はてブ", badgeClass: "src-hatena" },
  { key: "layerx", label: "LayerX", badgeClass: "src-layerx" },
  { key: "workspace", label: "Workspace", badgeClass: "src-workspace" },
  { key: "zenn", label: "Zenn", badgeClass: "src-zenn" },
  { key: "qiita", label: "Qiita", badgeClass: "src-qiita" },
];

export function sourceLabel(source: FeedSource): string {
  return SOURCES.find((s) => s.key === source)?.label ?? source;
}

/** feed.json の source が SOURCES に登録済みか（外部 JSON 由来の未知値を弾く用）。 */
export function isKnownSource(source: string): source is FeedSource {
  return SOURCES.some((s) => s.key === source);
}

/** source のメタ。未登録なら中立フォールバック（バッジ色なし・ラベルは生の source）。 */
export function sourceMeta(source: FeedSource): SourceMeta {
  return SOURCES.find((s) => s.key === source) ?? { key: source, label: source, badgeClass: "" };
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

/** タイムレール用の時刻のみ（"06:50"）。パース不可なら空文字。 */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
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
