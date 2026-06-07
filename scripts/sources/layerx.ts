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
 *   - 件名  : その回のニュース見出し → title
 *   - 本文先頭: "View this post on the web at https://layerxnews.substack.com/p/<slug>" → url
 *   - 粒度  : 1メール = 1 FeedItem（週次ダイジェスト1件）
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

function snippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const text = s.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 200 ? text.slice(0, 197) + "…" : text;
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

      const subject = header(msg, "Subject")?.trim();
      const dateHeader = header(msg, "Date");
      const publishedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

      const plain = extractBody(msg.payload, "text/plain");

      // 本文先頭の "View this post on the web at <url>" を記事リンクとして使う
      const canonical = plain?.match(
        /View this post on the web at\s+(https:\/\/layerxnews\.substack\.com\/p\/\S+)/,
      )?.[1];
      const url = canonical ?? `https://mail.google.com/mail/u/0/#all/${id}`;

      // summary: 先頭の "View this post…" 行を除去して要約
      const bodyForSummary = plain?.replace(/^View this post on the web at\s+\S+\s*/, "");
      const summary = snippet(bodyForSummary);

      // thumbnail は付けない: 本文の Substack CDN 画像は 36px のアイコンばかりで
      // サムネとして使えるヘッダー画像が無いため（はてブ/Feedly 同様 thumbnail なしで表示）。

      items.push({
        id: `layerx-${canonical ?? id}`,
        source: "layerx",
        title: subject || "LayerX AI・LLM Newsletter",
        url,
        publishedAt,
        summary,
        author: "LayerX AI・LLM Newsletter",
      });
    } catch (e) {
      console.warn(`[layerx] 1メール処理失敗（スキップ）: ${id} — ${(e as Error).message}`);
    }
  }

  return items;
}
