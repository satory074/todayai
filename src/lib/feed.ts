/** 全情報源を統一する正規化済みフィードアイテム。 */
export type FeedSource = "x" | "zenn" | "qiita" | "hatena" | "layerx" | "workspace" | "gcloud" | "ipa";

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
   * X ツイート本文中の t.co リンク先の OGP プレビュー（リンクカード）。集約時に enrichXLinks が解決し、
   * title/description は translate ステップで日本語補完（titleJa/descriptionJa）。表示は TweetCard。
   */
  linkPreview?: XLinkCard & { titleJa?: string; descriptionJa?: string };
  /**
   * 集約中のみの一時フィールド。記事ページから抽出した本文プレーンテキスト（要約の入力に使う）。
   * `aggregate.ts` が feed.json 書き出し前に削除するので、永続化された feed.json には残らない。
   */
  contentText?: string;
}

/**
 * X ツイート本文リンク（t.co）の解決結果 = リンクプレビューカード（原文のみ・日本語訳は別途）。
 * enrichXLinks が resolvePage + OGP / syndication で解決し `state.xLinkCards` にキャッシュする。
 */
export interface XLinkCard {
  /** リダイレクト解決後の最終 URL（カードのタップ遷移先） */
  url: string;
  /** og:title / twitter:title（原文） */
  title?: string;
  /** og:description / twitter:description（原文） */
  description?: string;
  /** og:image / twitter:image */
  image?: string;
  /** 表示用ホスト（www. 除去） */
  domain: string;
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
     * X item id(`x-<id>`) -> リンクプレビューカード（原文）/ null(確認済み・カードなしの負キャッシュ)。
     * 毎回フレッシュ取得される X 項目にも再適用するための永続化。fetch 失敗も null で記録し再取得を抑制。
     */
    xLinkCards?: Record<string, XLinkCard | null>;
    /**
     * item id -> 翻訳/要約キャッシュ（毎回フレッシュ取得されるソースでも再翻訳しないための永続化）。
     * titleJa は原文が日本語なら未設定、summaryJa は記事系=3行要約 / その他=翻訳。
     * linkTitleJa/linkDescJa は linkPreview（X リンクカード）の title/description の日本語訳。
     */
    translations?: Record<
      string,
      { titleJa?: string; summaryJa?: string; linkTitleJa?: string; linkDescJa?: string }
    >;
    /** translations の生成ロジック版。ENRICH_VERSION と不一致なら作り直す。 */
    enrichVersion?: string;
  };
}

export interface SourceMeta {
  key: FeedSource;
  label: string;
  /** Tailwind 用のアクセントクラス（バッジ等） */
  badgeClass: string;
  /**
   * 出典元の「人間向け」ページ（フィード URL ではない）。
   * フィルタバーの出典行と /about のカードが参照する＝出典 URL の単一の置き場所。
   * feeds.config.ts の rssUrl は scripts 専用（Astro から未 import）なので二重管理しない。
   */
  originUrl: string;
  /** 出典行・about に出す表示名 */
  originLabel: string;
  /** 補足（購読方法など）。任意 */
  originNote?: string;
}

// 並び順がそのままフィルタチップの表示順（先頭に「すべて」が付く）。
export const SOURCES: SourceMeta[] = [
  {
    key: "x",
    label: "X",
    badgeClass: "src-x",
    originUrl: "https://x.com/",
    originLabel: "x.com",
  },
  {
    key: "workspace",
    label: "Workspace",
    badgeClass: "src-workspace",
    originUrl: "https://workspaceupdates.googleblog.com/",
    originLabel: "Google Workspace Updates",
  },
  {
    key: "layerx",
    label: "LayerX",
    badgeClass: "src-layerx",
    // 株式会社LayerX 発行の週刊ニュースレター。LayerX 公式サイト（layerx.co.jp/jobs/aillm/）が
    // このURLをリンクしている＝公式の購読導線。layerx.co.jp/newsletter は存在しない（404）。
    originUrl: "https://layerxnews.substack.com/",
    originLabel: "LayerX AI・LLM Newsletter",
    originNote: "株式会社LayerX 発行の週刊ニュースレター（Substack・無料）。過去号のウェブ閲覧は購読者限定。",
  },
  {
    key: "hatena",
    label: "はてブ",
    badgeClass: "src-hatena",
    originUrl: "https://b.hatena.ne.jp/hotentry/it",
    originLabel: "はてなブックマーク 人気エントリー・テクノロジー",
  },
  {
    key: "zenn",
    label: "Zenn",
    badgeClass: "src-zenn",
    originUrl: "https://zenn.dev/topics/ai",
    originLabel: "Zenn「AI」トピック",
  },
  {
    key: "qiita",
    label: "Qiita",
    badgeClass: "src-qiita",
    originUrl: "https://qiita.com/tags/ai",
    originLabel: "Qiita「AI」タグ",
  },
  {
    key: "gcloud",
    label: "GCP",
    badgeClass: "src-gcloud",
    // cloud.google.com/release-notes は docs.cloud.google.com へ 301（rssUrl と同じドメイン）
    originUrl: "https://docs.cloud.google.com/release-notes",
    originLabel: "Google Cloud リリースノート",
  },
  {
    key: "ipa",
    label: "IPA",
    badgeClass: "src-ipa",
    // 年別の一覧（security-alert/2026/index.html 等）は年が変わると古くなるので、年をまたぐ入口を指す
    originUrl: "https://www.ipa.go.jp/security/security-alert/index.html",
    originLabel: "IPA 重要なセキュリティ情報",
  },
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
  return (
    SOURCES.find((s) => s.key === source) ?? {
      key: source,
      label: source,
      badgeClass: "",
      // 未登録ソースは描画前に isKnownSource で弾かれるので出典は空（リンクは出さない）
      originUrl: "",
      originLabel: source,
    }
  );
}

// ===== 表示用の取捨選択（著者）=====

/**
 * 旧集約が author に入れていたフィード名（記事の書き手ではない）。全件に同じ文言が出るだけなので隠す。
 * scripts/sources/rss.ts は実際の書き手（Zenn=dc:creator / Qiita=author）を入れるよう修正済みだが、
 * キャッシュに残る古い項目はフィード名のままなので表示側でも弾く。
 */
const FEED_NAME_AUTHORS = new Set(["Zennの「AI」のフィード", "AIタグが付けられた新着記事 - Qiita"]);
/** author が常にフィード名・発行元になるソース（書き手の情報がない） */
const NO_AUTHOR_SOURCES: readonly FeedSource[] = ["layerx", "workspace", "gcloud", "ipa"];

/** 記事カードに出す著者名。出さないなら undefined（X は TweetCard が別に扱う）。 */
export function displayAuthor(item: FeedItem): string | undefined {
  if (item.source === "x" || NO_AUTHOR_SOURCES.includes(item.source)) return undefined;
  const a = item.author?.trim();
  return a && !FEED_NAME_AUTHORS.has(a) ? a : undefined;
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
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 行のメタに出す時刻のみ（"06:50"）。JST 固定。パース不可なら空文字。 */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 更新時刻などの短い絶対表記（"11/14 08:22"）。JST 固定。パース不可なら空文字。 */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * 行の短い識別子（item.id の FNV-1a 32bit を base36、6〜7 文字）。「前回以降の新着」の既読管理で
 * localStorage に数百件ぶん保存するので、URL そのもの（id）より短くする。
 */
export function itemKey(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
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

/**
 * X アイテムのアカウント絞り込みキー。Timeline の `data-x-account` と
 * SourceFilter のチップ `data-account` が同じ値を使う＝定義はここ1か所。
 * ハンドルが解決できたものは "@handle"、未解決（author が "ブックマーク" 等の
 * カテゴリラベルのまま）は X_ACCOUNT_OTHER にまとめる。
 */
export const X_ACCOUNT_OTHER = "__other";

export function xAccountKey(item: FeedItem): string {
  const a = parseXAuthor(item.author);
  return a.kind === "handle" && a.handle ? `@${a.handle}` : X_ACCOUNT_OTHER;
}

/** フィルタチップ1個分のアカウント情報。 */
export interface XAccountMeta {
  /** 絞り込みキー（"@handle" or X_ACCOUNT_OTHER） */
  key: string;
  /** チップの表示名（表示名が無ければ "@handle"） */
  label: string;
  /** "@" を除いたハンドル。未解決なら未設定 */
  handle?: string;
  avatarUrl?: string;
  count: number;
}

/**
 * ページに描画済みの items から X アカウント一覧を導出する（件数降順）。
 * feeds.config.ts の `x.accounts` は外部アカウント分しか列挙していないのに対し、
 * ブックマークは任意アカウントの投稿を含む（実測 88 ハンドル）ため、
 * 必ず items 側から作る。ページごとに母数が違うので件数もページ単位。
 */
export function xAccountsOf(items: FeedItem[]): XAccountMeta[] {
  const map = new Map<string, XAccountMeta>();
  for (const item of items) {
    if (item.source !== "x") continue;
    const key = xAccountKey(item);
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      // 著者解決は段階的に進むので、後から出てきた表示名/アイコンで穴埋めする
      existing.avatarUrl ??= item.avatarUrl;
      if (existing.handle && existing.label === `@${existing.handle}` && item.authorName) {
        existing.label = item.authorName;
      }
      continue;
    }
    const handle = key === X_ACCOUNT_OTHER ? undefined : key.slice(1);
    map.set(key, {
      key,
      label: handle ? (item.authorName ?? `@${handle}`) : "その他",
      handle,
      avatarUrl: item.avatarUrl,
      count: 1,
    });
  }
  // 件数降順 → 同数はキー昇順（ビルド間で並びがぶれないように）。
  // 著者未解決の「その他」は件数に関わらず末尾へ（上位を占有させない）。
  return [...map.values()].sort((a, b) => {
    if (a.key === X_ACCOUNT_OTHER) return 1;
    if (b.key === X_ACCOUNT_OTHER) return -1;
    return b.count - a.count || a.key.localeCompare(b.key);
  });
}

// en-CA は "YYYY-MM-DD" 形式。JST 暦日でグループ化する（数千件で呼ぶので書式オブジェクトは使い回す）。
const JST_DAY_KEY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 日付ヘッダ用のキー（JST 暦日 "2026-06-03"）。パース不可なら空文字。 */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return JST_DAY_KEY_FMT.format(d);
}

/** 月キー（JST 暦月 "2026-08"）。パース不可なら空文字。 */
export function monthKey(iso: string): string {
  return dayKey(iso).slice(0, 7);
}

/** 月キーの表示（"2026年8月"）。 */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${Number(y)}年${Number(m)}月`;
}

/** アーカイブナビ用の月メタ。 */
export interface MonthMeta {
  key: string;
  label: string;
  count: number;
}

/** items（降順ソート済み想定）から月メタ一覧（新しい月順）。 */
export function monthsOf(items: FeedItem[]): MonthMeta[] {
  const months = new Map<string, MonthMeta>();
  for (const item of items) {
    const key = monthKey(item.publishedAt);
    const meta = months.get(key);
    if (meta) meta.count++;
    else months.set(key, { key, label: monthLabel(key), count: 1 });
  }
  return [...months.values()];
}

// ===== 絞り込みチップの単位 =====
// タイムラインは全ソースを時刻順に混ぜて出す。チップだけは Workspace・GCP・IPA を「公式」にまとめる
// （どれも 1 日 0〜2 件で、別々のチップにするとチップバーが長くなるだけ）。

export type SectionKey = "x" | "official" | "hatena" | "layerx" | "zenn" | "qiita";

export interface SectionDef {
  key: SectionKey;
  /** フィルタチップの表示名 */
  label: string;
  sources: readonly FeedSource[];
}

/** 並び順がそのままフィルタチップの順。 */
export const SECTIONS: readonly SectionDef[] = [
  { key: "x", label: "X", sources: ["x"] },
  { key: "official", label: "公式", sources: ["workspace", "gcloud", "ipa"] },
  { key: "hatena", label: "はてブ", sources: ["hatena"] },
  { key: "layerx", label: "LayerX", sources: ["layerx"] },
  { key: "zenn", label: "Zenn", sources: ["zenn"] },
  { key: "qiita", label: "Qiita", sources: ["qiita"] },
];

/** ソース → チップ。Record なのでソースを足すと型エラーになり、割り当て漏れに気づける。 */
export const SECTION_OF: Record<FeedSource, SectionKey> = {
  x: "x",
  workspace: "official",
  gcloud: "official",
  ipa: "official",
  hatena: "hatena",
  layerx: "layerx",
  zenn: "zenn",
  qiita: "qiita",
};

// ===== 日ごとのまとまり（時系列タイムライン）=====

export interface DayGroup {
  /** JST 暦日 "2026-11-14" */
  key: string;
  /** "11月14日(土)" */
  label: string;
  /** その日のアイテム（入力の並び＝新しい順のまま） */
  items: FeedItem[];
}

/** items（降順ソート済み想定）を JST 暦日ごとにまとめる。日も新しい順。 */
export function groupByDay(items: FeedItem[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | undefined;
  for (const item of items) {
    const key = dayKey(item.publishedAt);
    if (!key) continue;
    if (current?.key !== key) {
      current = { key, label: formatDayLabel(key), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

/**
 * アーカイブの月内ページ分割。target 件を目安に「日の境目」でだけ切る
 * （1 日の途中で切ると、日付見出しと「その日の分」が 2 ページに割れて読みにくいため）。
 * 1 日だけで target を超える日はその日ごと 1 ページ。items は降順ソート済み想定。
 */
export function paginateByDay(items: FeedItem[], target: number): FeedItem[][] {
  const pages: FeedItem[][] = [];
  let page: FeedItem[] = [];
  let i = 0;
  while (i < items.length) {
    const key = dayKey(items[i].publishedAt);
    let j = i + 1;
    while (j < items.length && dayKey(items[j].publishedAt) === key) j++;
    if (page.length > 0 && page.length + (j - i) > target) {
      pages.push(page);
      page = [];
    }
    page = page.concat(items.slice(i, j));
    i = j;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

// トップページの表示ウィンドウ。全ソース直近 WINDOW_DAYS 日（JST 暦日）を描画し、
// 流量の多い LIMITED_SOURCES は初期表示 LIMITED_DAYS 日＋残りを折りたたみ（「もっと見せる」で展開）。
// それより前は月別アーカイブへ。
const WINDOW_DAYS = 7;
const LIMITED_DAYS = 2;
/** 初期表示を LIMITED_DAYS 日に制限するソース（並びは「もっと見せる」ボタン文言の表示順） */
export const LIMITED_SOURCES: readonly FeedSource[] = ["hatena", "zenn", "qiita"];

/** JST 暦日キーを days 日ずらす（負で過去）。UTC 正午に置けば JST でも同じ暦日 */
function shiftDayKey(key: string, days: number): string {
  return dayKey(new Date(new Date(key + "T12:00:00Z").getTime() + days * 86400000).toISOString());
}

export interface RecentWindow {
  items: FeedItem[];
  /** 初期状態で折りたたむアイテム id（LIMITED_SOURCES の LIMITED_DAYS+1 日目以降） */
  collapsedIds: Set<string>;
}

/**
 * 降順ソート済み items から直近 WINDOW_DAYS 日（JST 暦日）分を切り出す。
 * 基準日は最新アイテムの暦日（wall-clock ではない＝フィードが stale でも空ページにならない）。
 */
export function takeRecentWindow(items: FeedItem[]): RecentWindow {
  const collapsedIds = new Set<string>();
  if (items.length === 0) return { items: [], collapsedIds };
  const anchor = dayKey(items[0].publishedAt);
  const cutoff = shiftDayKey(anchor, -(WINDOW_DAYS - 1));
  const limitedCutoff = shiftDayKey(anchor, -(LIMITED_DAYS - 1));
  const out: FeedItem[] = [];
  for (const item of items) {
    const key = dayKey(item.publishedAt);
    if (!key || key < cutoff) continue;
    out.push(item);
    if (key < limitedCutoff && LIMITED_SOURCES.includes(item.source)) collapsedIds.add(item.id);
  }
  return { items: out, collapsedIds };
}

// JST 暦日 key（"2026-11-14"）の表示。UTC 正午に置けば JST でフォーマットしても同じ日付。
// 「今日」「昨日」はビルド時には決めない（6 時間ごとの静的ビルドなので閲覧時にはずれる）。
// 閲覧時の補正は Timeline のクライアントスクリプトが行う。
const DAY_LABEL_FMT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "long",
  day: "numeric",
  weekday: "short",
});

/** "11月14日(金)" */
export function formatDayLabel(key: string): string {
  return DAY_LABEL_FMT.format(new Date(key + "T12:00:00Z"));
}
