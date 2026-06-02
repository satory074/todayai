/**
 * X (Twitter) ソース取得。
 *
 * 他人アカウントを公式 API (Non-owned Read = $0.005/件) で取得するため、
 * since_id による増分取得で「同じ投稿の読み直し課金」を回避する。
 *
 * OAuth2 のリフレッシュトークンは X 側で都度ローテーションするため、
 * basecamp/scripts/update-x-feed.ts のトークン更新ロジックを踏襲し、
 * CI では gh CLI で GitHub Secrets に書き戻す。
 *
 * 必要な環境変数: X_CLIENT_ID / X_CLIENT_SECRET / X_REFRESH_TOKEN
 * CI のみ: GH_PAT / GITHUB_REPOSITORY（リフレッシュトークン書き戻し用）
 */
import type { FeedItem } from "../../src/lib/feed";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_API_BASE = "https://api.x.com/2";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface XUser {
  id: string;
  name: string;
  username: string;
}

interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  attachments?: { media_keys?: string[] };
}

interface XMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
}

interface XTweetsResponse {
  data?: XTweet[];
  includes?: { media?: XMedia[] };
  meta?: { result_count: number; newest_id?: string };
}

export interface XFetchResult {
  items: FeedItem[];
  /** 次回 since_id に使う最新ツイートID（取得が空なら前回値を維持する想定で undefined） */
  newestId?: string;
  /** username 解決結果（呼び出し側で state にキャッシュ） */
  userId?: string;
}

// ---- Token 管理（basecamp 流用） ----

async function refreshAccessToken(): Promise<{ accessToken: string; newRefreshToken: string }> {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const refreshToken = process.env.X_REFRESH_TOKEN;
  if (!clientId || !refreshToken) {
    throw new Error("Missing X_CLIENT_ID or X_REFRESH_TOKEN");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (clientSecret) {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  }

  const res = await fetch(TOKEN_URL, { method: "POST", headers, body: params.toString() });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data: TokenResponse = await res.json();
  if (!data.refresh_token) {
    throw new Error(
      `Token response missing refresh_token (offline.access scope required). keys: ${Object.keys(data).join(", ")}`,
    );
  }
  return { accessToken: data.access_token, newRefreshToken: data.refresh_token };
}

async function persistRefreshToken(newRefreshToken: string): Promise<void> {
  const ghPat = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!ghPat || !repo) {
    console.warn("[x] GH_PAT/GITHUB_REPOSITORY 未設定。新 refresh token は手動保存してください:");
    console.warn("[x] X_REFRESH_TOKEN =", newRefreshToken);
    return;
  }
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "gh",
    ["secret", "set", "X_REFRESH_TOKEN", "--repo", repo, "--body", newRefreshToken],
    { env: { ...process.env, GH_TOKEN: ghPat }, stdio: "pipe" },
  );
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    console.error("[x] gh secret set 失敗:", stderr);
    console.warn("[x] X_REFRESH_TOKEN（手動保存）=", newRefreshToken);
    throw new Error(`gh secret set failed (exit ${result.status})`);
  }
  console.log("[x] GitHub Secrets の X_REFRESH_TOKEN を更新しました");
}

// ---- API 呼び出し ----

async function resolveUserId(username: string, accessToken: string): Promise<XUser> {
  const res = await fetch(`${X_API_BASE}/users/by/username/${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`users/by/username failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: XUser };
  if (!json.data) throw new Error(`User not found: @${username}`);
  return json.data;
}

function toFeedItems(
  tweets: XTweet[],
  media: XMedia[],
  username: string,
): FeedItem[] {
  const mediaByKey = new Map(media.map((m) => [m.media_key, m]));
  return tweets
    .filter((t) => !t.text.startsWith("RT @")) // リツイートは除外
    .map((t) => {
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
      const title = text.length > 140 ? text.slice(0, 137) + "…" : text;
      return {
        id: `x-${t.id}`,
        source: "x" as const,
        title,
        url: `https://x.com/${username}/status/${t.id}`,
        publishedAt: t.created_at ?? new Date().toISOString(),
        summary: text !== title ? text : undefined,
        thumbnail,
        author: `@${username}`,
      };
    });
}

export async function fetchX(opts: {
  username: string;
  maxResults: number;
  sinceId?: string;
  cachedUserId?: string;
}): Promise<XFetchResult> {
  const { accessToken, newRefreshToken } = await refreshAccessToken();
  // ローテーションした refresh token を永続化（失敗してもフェッチは続行）
  try {
    if (newRefreshToken !== process.env.X_REFRESH_TOKEN) {
      await persistRefreshToken(newRefreshToken);
    }
  } catch (e) {
    console.error("[x] refresh token 永続化に失敗（続行）:", (e as Error).message);
  }

  let userId = opts.cachedUserId;
  if (!userId) {
    const user = await resolveUserId(opts.username, accessToken);
    userId = user.id;
  }

  const url = new URL(`${X_API_BASE}/users/${userId}/tweets`);
  url.searchParams.set("max_results", String(Math.max(5, Math.min(100, opts.maxResults))));
  url.searchParams.set("tweet.fields", "created_at,attachments");
  url.searchParams.set("expansions", "attachments.media_keys");
  url.searchParams.set("media.fields", "url,preview_image_url,type");
  url.searchParams.set("exclude", "retweets,replies");
  // ★ since_id で増分取得（重複課金回避）
  if (opts.sinceId) url.searchParams.set("since_id", opts.sinceId);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`users/:id/tweets failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as XTweetsResponse;
  const tweets = json.data ?? [];
  const items = toFeedItems(tweets, json.includes?.media ?? [], opts.username);

  return {
    items,
    newestId: json.meta?.newest_id,
    userId,
  };
}
