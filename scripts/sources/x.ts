/**
 * X (Twitter) ソース取得。
 *
 * X API を直接叩く代わりに、basecamp が公開している x-tweets.json を読む。
 *   - X API / トークン / 追加課金が不要
 *   - OAuth リフレッシュトークンが basecamp と競合しない
 *
 * 公開JSONの構造: { username, tweets: [{ id, date, category, description, isRetweet? }] }
 * category は "post" | "like" | "bookmark"。
 */
import type { FeedItem, XAuthorMeta } from "../../src/lib/feed";
import type { XCategory } from "../../feeds.config";
import { resolveOgImage } from "./ogp";
import { fetchTweet } from "./syndication";
import { mapLimit, truncateSafe } from "./util";

/** プロフィール画像URLを高解像度（_400x400）に置換。`_normal.jpg` → `_400x400.jpg`。 */
function hiResAvatar(url: string): string {
  return url.replace(/_normal(\.\w+)?($|\?)/, "_400x400$1$2");
}

/** 解決した著者メタを item に反映（author=@handle / 実名 / アバター）。 */
function applyAuthor(item: FeedItem, a: XAuthorMeta): void {
  item.author = `@${a.handle}`;
  item.authorName = a.name;
  if (a.avatar) item.avatarUrl = a.avatar;
}

interface XTweetEntry {
  id: string;
  date: string;
  category: XCategory;
  description?: string;
  isRetweet?: boolean;
}

interface XTweetsFile {
  username: string;
  tweets: XTweetEntry[];
}

const CATEGORY_LABEL: Record<XCategory, string> = {
  post: "投稿",
  like: "いいね",
  bookmark: "ブックマーク",
};

/** 末尾の t.co 短縮URLを除去して表示を整える。 */
function cleanText(text: string): string {
  return text.replace(/\s*https?:\/\/t\.co\/\S+\s*$/g, "").trim();
}

/** 本文中の t.co URL を出現順に抽出（OGP サムネ補完用）。 */
function extractTcoUrls(text: string): string[] {
  return text.match(/https?:\/\/t\.co\/\S+/g) ?? [];
}

// ===== 外部アカウントのポスト（X API App-only Bearer + since_id 増分） =====

const X_API_BASE = "https://api.x.com/2";

interface XApiTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  attachments?: { media_keys?: string[] };
}
interface XApiMedia {
  media_key: string;
  url?: string;
  preview_image_url?: string;
}
interface XApiUser {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
}
interface XUserTweetsResponse {
  data?: XApiTweet[];
  includes?: { media?: XApiMedia[]; users?: XApiUser[] };
  meta?: { result_count: number; newest_id?: string };
  errors?: unknown;
}

export interface XAccountsResult {
  items: FeedItem[];
  /** username -> 次回 since_id に使う最新ツイートID（呼び出し側で state に保存） */
  sinceIds: Record<string, string>;
}

async function resolveUserId(username: string, bearer: string): Promise<string> {
  const res = await fetch(`${X_API_BASE}/users/by/username/${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    throw new Error(`users/by/username @${username} failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: { id: string } };
  if (!json.data?.id) throw new Error(`User not found: @${username}`);
  return json.data.id;
}

/**
 * 複数の外部アカウントの新着ポストを App-only Bearer で取得。
 * since_id（前回最新ID）を渡すことで新着のみ取得＝重複課金を回避。
 * 1アカウントの失敗は他に波及させない（個別 catch）。
 */
export async function fetchXAccounts(opts: {
  accounts: string[];
  bearer: string;
  maxResults: number;
  /** username -> 前回 since_id / username -> userId キャッシュ */
  sinceIds: Record<string, string>;
  userIds: Record<string, string>;
}): Promise<XAccountsResult & { userIds: Record<string, string>; errors: string[] }> {
  const items: FeedItem[] = [];
  const newSinceIds: Record<string, string> = { ...opts.sinceIds };
  const userIds: Record<string, string> = { ...opts.userIds };
  const errors: string[] = [];

  for (const username of opts.accounts) {
    try {
      let userId = userIds[username];
      if (!userId) {
        userId = await resolveUserId(username, opts.bearer);
        userIds[username] = userId;
      }
      const url = new URL(`${X_API_BASE}/users/${userId}/tweets`);
      url.searchParams.set("max_results", String(Math.max(5, Math.min(100, opts.maxResults))));
      url.searchParams.set("tweet.fields", "created_at,attachments");
      url.searchParams.set("expansions", "attachments.media_keys,author_id");
      url.searchParams.set("media.fields", "url,preview_image_url");
      url.searchParams.set("user.fields", "profile_image_url,name,username");
      url.searchParams.set("exclude", "retweets,replies");
      const since = opts.sinceIds[username];
      if (since) url.searchParams.set("since_id", since); // ★ 新着のみ＝重複課金回避

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${opts.bearer}` },
      });
      if (!res.ok) {
        throw new Error(`users/${userId}/tweets failed (${res.status}): ${await res.text()}`);
      }
      const json = (await res.json()) as XUserTweetsResponse;
      const mediaByKey = new Map((json.includes?.media ?? []).map((m) => [m.media_key, m]));
      const usersById = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
      for (const t of json.data ?? []) {
        let thumbnail: string | undefined;
        for (const key of t.attachments?.media_keys ?? []) {
          const m = mediaByKey.get(key);
          const u = m?.url ?? m?.preview_image_url;
          if (u) {
            thumbnail = u;
            break;
          }
        }
        const text = t.text.trim();
        const title = truncateSafe(text, 140, 137);
        const user = t.author_id ? usersById.get(t.author_id) : undefined;
        items.push({
          id: `x-${t.id}`,
          source: "x",
          title,
          url: `https://x.com/${username}/status/${t.id}`,
          publishedAt: t.created_at ?? new Date().toISOString(),
          summary: text !== title ? text : undefined,
          thumbnail,
          author: `@${username}`,
          authorName: user?.name,
          avatarUrl: user?.profile_image_url ? hiResAvatar(user.profile_image_url) : undefined,
        });
      }
      if (json.meta?.newest_id) newSinceIds[username] = json.meta.newest_id;
    } catch (e) {
      errors.push(`x @${username}: ${(e as Error).message}`);
    }
  }
  return { items, sinceIds: newSinceIds, userIds, errors };
}

// ===== 自分のデータ（basecamp 公開JSON） =====

export interface FetchXResult {
  items: FeedItem[];
  /** tweet id(`x-<id>`) -> OGP画像URL / "" (確認済み・画像なし) のキャッシュ */
  ogCache: Record<string, string>;
  /** tweet id(`x-<id>`) -> 著者メタ / null (確認済み・著者なし) のキャッシュ */
  authorCache: Record<string, XAuthorMeta | null>;
}

export async function fetchX(opts: {
  sourceUrl: string;
  username: string;
  categories: XCategory[];
  /** 前回までの OGP サムネ取得結果（負キャッシュ含む）。再取得回避に使う */
  ogCache?: Record<string, string>;
  /** 前回までの著者解決結果（負キャッシュ含む）。再取得回避に使う */
  authorCache?: Record<string, XAuthorMeta | null>;
  /** 1run あたりの著者新規解決の上限（CIの負荷・syndication 非公式API依存を抑える） */
  authorMaxNew?: number;
}): Promise<FetchXResult> {
  const res = await fetch(opts.sourceUrl, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) {
    throw new Error(`x-tweets.json fetch failed (${res.status}): ${opts.sourceUrl}`);
  }
  const file = (await res.json()) as XTweetsFile;
  const wanted = new Set(opts.categories);
  const ogCache: Record<string, string> = { ...(opts.ogCache ?? {}) };

  const items: FeedItem[] = [];
  // OGP 解決待ちのアイテム（生本文から t.co を抽出できたもの）
  const pending: { item: FeedItem; tcoUrls: string[] }[] = [];

  for (const t of file.tweets ?? []) {
    if (!wanted.has(t.category)) continue;
    if (t.isRetweet) continue;
    const raw = (t.description ?? "").trim();
    const text = cleanText(raw) || raw;
    if (!text) continue;
    const title = truncateSafe(text, 140, 137);
    // 自分の投稿は自アカウントURL、いいね/ブックマークは作者不明のため /i/status を使う
    const url =
      t.category === "post"
        ? `https://x.com/${opts.username}/status/${t.id}`
        : `https://x.com/i/status/${t.id}`;
    const item: FeedItem = {
      id: `x-${t.id}`,
      source: "x",
      title,
      url,
      publishedAt: t.date,
      summary: text !== title ? text : undefined,
      author: t.category === "post" ? `@${opts.username}` : CATEGORY_LABEL[t.category],
    };

    // サムネ補完: キャッシュ済みなら流用、未確認なら t.co を OGP 解決対象に積む
    const cached = ogCache[item.id];
    if (cached !== undefined) {
      if (cached) item.thumbnail = cached;
    } else {
      const tcoUrls = extractTcoUrls(raw);
      if (tcoUrls.length > 0) pending.push({ item, tcoUrls });
    }

    items.push(item);
  }

  // 新規分のみ OGP 解決（並列5・各5秒タイムアウト）。1つでも取れたら採用、無ければ負キャッシュ。
  if (pending.length > 0) {
    await mapLimit(pending, 5, async ({ item, tcoUrls }) => {
      let found: string | undefined;
      for (const tco of tcoUrls) {
        found = await resolveOgImage(tco);
        if (found) break;
      }
      if (found) item.thumbnail = found;
      ogCache[item.id] = found ?? "";
    });
  }

  // 著者解決: basecamp 公開JSON は元ツイートの著者・アイコンを持たない（author は "ブックマーク" 等の
  // 固定ラベル）。syndication（cdn.syndication.twimg.com・無料）で著者名/@handle/アイコンを復元する。
  // ・既知（authorCache に object）は再適用、未確認（キー無し）のみ新規解決（authorMaxNew で 1run 制限）。
  // ・fetch 失敗（undefined＝transient/CIブロック）は記録せず次回 run で再試行（負キャッシュ汚染を防ぐ）。
  // ・確認済み・著者なし（user 無し）は null を入れて再試行しない。
  const authorCache: Record<string, XAuthorMeta | null> = { ...(opts.authorCache ?? {}) };
  for (const item of items) {
    const a = authorCache[item.id];
    if (a) applyAuthor(item, a); // null / 未設定はスキップ（フォールバック表示）
  }
  const needAuthor = items.filter((item) => !(item.id in authorCache));
  const toResolve = needAuthor.slice(0, opts.authorMaxNew ?? 40);
  if (toResolve.length > 0) {
    await mapLimit(toResolve, 5, async (item) => {
      const tweetId = item.id.replace(/^x-/, "");
      const tw = await fetchTweet(tweetId);
      if (!tw) return; // transient/CIブロック → 記録せず次回再試行
      if (tw.author) {
        authorCache[item.id] = tw.author;
        applyAuthor(item, tw.author);
      } else {
        authorCache[item.id] = null; // 確認済み・著者なし（負キャッシュ）
      }
    });
  }

  return { items, ogCache, authorCache };
}
