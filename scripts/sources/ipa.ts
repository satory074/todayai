/**
 * IPA「重要なセキュリティ情報」（緊急対策情報・注意喚起）。公開 RSS を直接取得（トークン不要）。
 *
 * フィードは RSS 1.0（RDF）の `https://www.ipa.go.jp/security/alert-rss.rdf`（rss-parser がそのまま読む）。
 * 一覧ページ `security-alert/<年>/index.html` が `<link>` で指しているもの。直近 ~30 件を返す。
 *
 * ⚠️ フィードの癖が2つある:
 *  1. **同じページが「掲載」と「更新：…」で複数エントリになる**（例: alert20261022.html が 10/22・10/27・11/02）。
 *     id をページ URL だけにすると更新が 1 件に潰れるので、`ipa-<url>#<dc:date>` にして**各お知らせを
 *     その日の 1 件**として残す（タイムライン＝いつ何が出たか）。
 *  2. **本文の抜粋（description）が無い**（title / link / dc:date だけ）。そこで記事ページを読んで、
 *     掲載エントリは「概要」節を `summary`・本文全体を `contentText`（3行要約の入力）にし、
 *     更新エントリはページ末尾の「更新履歴」からその日の行（例「CISAのKEVカタログへの登録に関して追記」）を
 *     `summary` にする（同じページの3行要約が日付違いで並ぶのを避け、何が変わったかを出す）。
 *
 * ページ取得は「前回までに summary を取れていないもの」だけ（既知分は前回の summary を流用）＝
 * 初回だけ ~30 ページ、以降は新着の数件。取れなかったものは title だけで出し、次回 run で再試行する。
 * og:image は全ページ共通の IPA ロゴなので取らない（サムネ無し＝コンパクト行で描画）。
 */
import Parser from "rss-parser";
import { dayKey, type FeedItem } from "../../src/lib/feed";
import { extractMainText, resolvePage } from "./ogp";
import { mapLimit, truncateSafe } from "./util";

type IpaItem = {
  title?: string;
  link?: string;
  isoDate?: string;
  creator?: string;
};

const parser: Parser<{ title?: string }, IpaItem> = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 (todayai feed aggregator)" },
});

/** HTML 片 → プレーンテキスト（extractMainText は断片にもそのまま使える）。 */
function text(fragment: string, maxLen = 2000): string {
  return extractMainText(fragment, maxLen);
}

/** 「概要」節（`<h2>概要</h2>` から次の `<h2>` まで）の本文。無ければ undefined。 */
function overview(html: string): string | undefined {
  const m = /<h2\b[^>]*>\s*概要\s*<\/h2>([\s\S]*?)(?=<h2\b|<\/main>)/i.exec(html);
  const t = m ? text(m[1], 400) : "";
  return t || undefined;
}

/** 「更新履歴」を JST 暦日 "YYYY-MM-DD" → その日の記載（"掲載" / "…について追記" 等）に。 */
function changeLog(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const box = /<section[^>]*class="[^"]*change-log-box[^"]*"[^>]*>([\s\S]*?)<\/section>/i.exec(html)?.[1];
  if (!box) return out;
  const re = /<p class="date">\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*<\/p>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(box))) {
    const key = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    const note = text(m[4], 400);
    // 同じ日に複数行あれば連結（まれ）
    if (note) out.set(key, out.has(key) ? `${out.get(key)} / ${note}` : note);
  }
  return out;
}

export async function fetchIpa(opts: {
  rssUrl: string;
  /** 前回までの IPA 項目（summary を取れていればページを読み直さない） */
  cached: FeedItem[];
  /** 1 run でページを読む上限（初回のバックフィルも含めて IPA に負荷をかけない） */
  maxPageFetch: number;
}): Promise<FeedItem[]> {
  const feed = await parser.parseURL(opts.rssUrl);
  const known = new Map(opts.cached.map((i) => [i.id, i]));

  const items: FeedItem[] = [];
  for (const it of feed.items) {
    const link = it.link?.trim();
    if (!link || !it.isoDate) continue;
    const id = `ipa-${link}#${it.isoDate}`;
    items.push({
      id,
      source: "ipa",
      title: it.title?.trim() || link,
      url: link,
      publishedAt: it.isoDate, // dc:date は日付のみ（JST 00:00）。時刻は持っていない
      summary: known.get(id)?.summary,
      author: it.creator?.trim() || "情報処理推進機構（IPA）",
    });
  }

  // summary が無いものだけ、ページ（URL 単位で 1 回）を読んで埋める。
  const need = new Map<string, FeedItem[]>();
  for (const item of items) {
    if (item.summary) continue;
    const arr = need.get(item.url);
    if (arr) arr.push(item);
    else need.set(item.url, [item]);
  }
  const urls = [...need.keys()].slice(0, opts.maxPageFetch);
  await mapLimit(urls, 3, async (url) => {
    const page = await resolvePage(url);
    if (!page?.html) return; // 取れなければ title だけ。次回 run で再試行
    const log = changeLog(page.html);
    const gist = overview(page.html);
    const body = text(page.html, 2000);
    for (const item of need.get(url) ?? []) {
      // 更新かどうかはタイトルの「更新：」で決める（更新履歴の行だけで見ると、掲載日に誤植修正も
      // 載っている「掲載 / …を修正」のような日を更新扱いしてしまう）。
      const isUpdate = /^更新[：:]/.test(item.title);
      const note = isUpdate ? log.get(dayKey(item.publishedAt)) : undefined;
      if (note) {
        // 更新のお知らせ: 何が変わったかだけ出す（ページ全体の要約は掲載日の 1 件に任せる）
        item.summary = truncateSafe(note, 200, 197);
      } else {
        item.summary = gist ? truncateSafe(gist, 200, 197) : body ? truncateSafe(body, 200, 197) : undefined;
        if (body) item.contentText = body;
      }
    }
  });
  return items;
}
