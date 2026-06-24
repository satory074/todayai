/**
 * X(Twitter) ツイートのメタ情報を、非公式の syndication エンドポイントから取得する。
 *
 * x.com 自身はログイン壁で og:image が取れないが、`cdn.syndication.twimg.com/tweet-result`
 * （Vercel の react-tweet が使う方式・無料・認証不要）はツイート本文・メディア・リンクを
 * JSON で返す。**非公式 API なので予告なく壊れ得る** → 失敗時は undefined を返し、
 * 呼び出し側はサムネ無しにフォールバックする（CI は落とさない）。
 *
 * LayerX ニュースレターの掲載リンクの多くが x.com（ツイート）に解決されるため、
 * それらのサムネ補完に使う（scripts/sources/layerxThumb.ts）。
 */
import { fetchWithTimeout } from "./ogp";

/** x.com / twitter.com の status URL からツイート ID を取り出す。 */
export function tweetIdFromUrl(url: string): string | undefined {
  return url.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/)?.[1];
}

/** react-tweet と同じ token 算出（精度欠落込みで syndication 側が受理する）。 */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

interface SynResponse {
  text?: string;
  mediaDetails?: { media_url_https?: string }[];
  photos?: { url?: string }[];
  entities?: { urls?: { expanded_url?: string }[] };
}

export interface TweetData {
  /** ツイート本文（t.co 短縮を含む生テキスト） */
  text: string;
  /** 添付メディア（写真/動画サムネ）の画像 URL。無ければ undefined */
  photo?: string;
  /** 本文に含まれる外部リンク（expanded_url）。リンク共有ツイートのサムネ解決に使う */
  links: string[];
}

/** ツイート ID から本文・メディア・リンクを取得。失敗時は undefined（呼び出し側でスキップ）。 */
export async function fetchTweet(id: string): Promise<TweetData | undefined> {
  try {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return undefined;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return undefined;
    const j = (await res.json()) as SynResponse;
    const photo = (j.mediaDetails ?? [])[0]?.media_url_https ?? (j.photos ?? [])[0]?.url;
    const links = (j.entities?.urls ?? [])
      .map((u) => u.expanded_url)
      .filter((u): u is string => !!u);
    return { text: j.text ?? "", photo, links };
  } catch {
    return undefined;
  }
}
