/**
 * LayerX AI・LLM Newsletter（Substack 発行・毎週 Gmail に届く）の取得。
 *
 * Substack の公開 RSS（layerxnews.substack.com/feed）は invite-only で取得できないため、
 * ユーザーの Gmail から該当メールを読み取って正規化する。集約は GitHub Actions（ヘッドレス）
 * で動くので、対話型コネクタは使えない → Gmail REST API を OAuth2 refresh token で直叩きする。
 *
 * 依存は追加しない（fetch のみ）。必要な認証情報は env / GitHub Secrets:
 *   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN（scope: gmail.readonly）
 *
 * メール構造（実メールで確認済み）:
 *   - 送信元: layerxnews@substack.com（毎週）
 *   - 本文(text/plain)は各セクションに `<タイトル> [ <substack redirect url> ]` 形式のトピック行が
 *     1通あたり ~190 行並ぶ。
 *   - 粒度  : 1トピック行 = 1 FeedItem（本文に列挙された全リンクを個別に取り込む）
 *   - サムネ: 各リンクを resolveOgImage で辿り最終記事の og:image を補完（state にキャッシュ）
 *   - 重複  : 同一リンク(UUID)は全メール横断で1件に集約（newer_than 窓内の最新号を採用）
 *
 * 行末に `[ url ]` がある行だけを採用することで、ボイラープレートが自然に除外される:
 *   - "View this post on the web at <url>"（ブラケット無し）
 *   - "Unsubscribe https://substack.com/redirect/2/<base64>?"（UUID 形でない＋ブラケット無し）
 *   - 文中プロモ "…製品紹介ページ [ url ]から資料を…"（`]` の後にテキストが続く＝行末でない）
 */
import type { FeedItem } from "../../src/lib/feed";
import { resolveOgImageDetailed } from "./ogp";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** 並列数を制限して非同期タスクを実行する簡易プール。 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  payload?: { headers?: GmailHeader[]; mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
}

/** refresh token を access token に交換する。 */
async function getAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`token 交換失敗 (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("access_token が返らなかった");
  return json.access_token;
}

/** base64url → UTF-8 文字列。 */
function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf-8");
}

/** payload を再帰探索し、指定 mimeType の本文をデコードして返す。 */
function extractBody(
  part: GmailPart | GmailMessage["payload"] | undefined,
  mimeType: string,
): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = extractBody(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function header(msg: GmailMessage, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * トピック行: `<タイトル> [ https://substack.com/redirect/<uuid>?j=<token> ]` が行末にあるもの。
 * group1=タイトル / group2=リダイレクトURL。行末アンカー `$` でボイラープレート・文中リンクを除外。
 */
const TOPIC_RE =
  /^(.+?)\s+\[\s*(https:\/\/substack\.com\/redirect\/[0-9a-f]{8}-[0-9a-f-]{27}\?j=[^\]\s]+)\s*\]\s*$/;

/** リダイレクトURLから安定した id 用 UUID を取り出す。 */
function redirectUuid(url: string): string | undefined {
  return url.match(/\/redirect\/([0-9a-f-]{36})/)?.[1];
}

export interface FetchLayerXResult {
  items: FeedItem[];
  /** トピック id(`layerx-<uuid>`) -> OGP画像URL / ""(確認済み・画像なし) のキャッシュ */
  ogCache: Record<string, string>;
}

export async function fetchLayerX(opts: {
  sender: string;
  newerThanDays: number;
  maxResults: number;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** 前回までの OGP サムネ取得結果（負キャッシュ含む）。再取得回避に使う */
  ogCache?: Record<string, string>;
}): Promise<FetchLayerXResult> {
  const accessToken = await getAccessToken(opts);
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  // 一覧取得（送信元 + 期間で絞り込み）
  const listUrl = new URL(`${GMAIL_API}/messages`);
  listUrl.searchParams.set("q", `from:${opts.sender} newer_than:${opts.newerThanDays}d`);
  listUrl.searchParams.set("maxResults", String(opts.maxResults));
  const listRes = await fetch(listUrl, { headers: authHeader });
  if (!listRes.ok) {
    throw new Error(`messages.list 失敗 (${listRes.status}): ${await listRes.text()}`);
  }
  const listJson = (await listRes.json()) as { messages?: { id: string }[] };
  const ids = (listJson.messages ?? []).map((m) => m.id);

  const ogCache: Record<string, string> = { ...(opts.ogCache ?? {}) };
  const items: FeedItem[] = [];
  const pending: FeedItem[] = []; // OGP 未確認のアイテム（新規分）
  const seen = new Set<string>(); // 全メール横断の id 重複排除（号またぎの同一リンクは最新号を採用）

  for (const id of ids) {
    try {
      const msgRes = await fetch(`${GMAIL_API}/messages/${id}?format=full`, { headers: authHeader });
      if (!msgRes.ok) {
        console.warn(`[layerx] 1メール取得失敗（スキップ）: ${id} (${msgRes.status})`);
        continue;
      }
      const msg = (await msgRes.json()) as GmailMessage;

      const dateHeader = header(msg, "Date");
      const baseMs = dateHeader ? new Date(dateHeader).getTime() : Date.now();
      const plain = extractBody(msg.payload, "text/plain");
      if (!plain) {
        console.warn(`[layerx] 本文(text/plain)無し（スキップ）: ${id}`);
        continue;
      }

      // 本文の各トピック行を個別の FeedItem にする。掲載順を保つため index 秒ずつ古くする。
      let topicIndex = 0;
      for (const rawLine of plain.split("\n")) {
        const m = TOPIC_RE.exec(rawLine.trim());
        if (!m) continue;
        const title = m[1].replace(/\s+/g, " ").trim();
        const url = m[2];
        const itemId = `layerx-${redirectUuid(url) ?? url}`;
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        const item: FeedItem = {
          id: itemId,
          source: "layerx",
          title,
          url,
          publishedAt: new Date(baseMs - topicIndex * 1000).toISOString(),
          author: "LayerX AI・LLM Newsletter",
        };
        // サムネ補完: キャッシュ済みなら流用、未確認なら OGP 解決対象に積む
        const cached = ogCache[itemId];
        if (cached !== undefined) {
          if (cached) item.thumbnail = cached;
        } else {
          pending.push(item);
        }
        items.push(item);
        topicIndex++;
      }
    } catch (e) {
      console.warn(`[layerx] 1メール処理失敗（スキップ）: ${id} — ${(e as Error).message}`);
    }
  }

  // 新規分のみ OGP 解決（substack リダイレクト追跡→最終記事の og:image）。
  // substack の redirect はバースト時にレート制限(429)を返すため、並列を絞り（3）、
  // 「確定的な結果」だけキャッシュする。一過性失敗(429/timeout)はキャッシュせず次回再試行
  // ＝負キャッシュ汚染を防ぎ、複数回の実行でカバレッジが収束する。
  if (pending.length > 0) {
    console.log(`[layerx] OGP 解決: ${pending.length} 件（新規・未キャッシュ）`);
    let resolved = 0;
    await mapLimit(pending, 3, async (item) => {
      const { image, definitive } = await resolveOgImageDetailed(item.url);
      if (image) item.thumbnail = image;
      if (definitive) {
        ogCache[item.id] = image ?? ""; // 成功 or 恒久的に無し のみ記録
        resolved++;
      }
    });
    console.log(`[layerx] OGP 確定: ${resolved}/${pending.length}（残りは一過性失敗・次回再試行）`);
  }

  return { items, ogCache };
}
