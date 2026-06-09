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
 *
 * 行末に `[ url ]` がある行だけを採用することで、ボイラープレートが自然に除外される:
 *   - "View this post on the web at <url>"（ブラケット無し）
 *   - "Unsubscribe https://substack.com/redirect/2/<base64>?"（UUID 形でない＋ブラケット無し）
 *   - 文中プロモ "…製品紹介ページ [ url ]から資料を…"（`]` の後にテキストが続く＝行末でない）
 */
import type { FeedItem } from "../../src/lib/feed";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

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

export async function fetchLayerX(opts: {
  sender: string;
  newerThanDays: number;
  maxResults: number;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<FeedItem[]> {
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

  const items: FeedItem[] = [];
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
      const seen = new Set<string>();
      let topicIndex = 0;
      for (const rawLine of plain.split("\n")) {
        const m = TOPIC_RE.exec(rawLine.trim());
        if (!m) continue;
        const title = m[1].replace(/\s+/g, " ").trim();
        const url = m[2];
        const uuid = redirectUuid(url);
        const itemId = `layerx-${uuid ?? url}`;
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        items.push({
          id: itemId,
          source: "layerx",
          title,
          url,
          publishedAt: new Date(baseMs - topicIndex * 1000).toISOString(),
          author: "LayerX AI・LLM Newsletter",
        });
        topicIndex++;
      }
    } catch (e) {
      console.warn(`[layerx] 1メール処理失敗（スキップ）: ${id} — ${(e as Error).message}`);
    }
  }

  return items;
}
