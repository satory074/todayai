/**
 * フィード情報源の設定。
 *
 * ★ 実運用前に以下を埋めること:
 *   - x.username       : 取得したい X(Twitter) アカウントのユーザー名（@ なし）
 *   - feedly.streamId  : Feedly カテゴリ(フォルダ)の streamId
 *                        形式: "user/<userId>/category/<categoryName>"
 *                        取得方法は README.md 参照
 *
 * トークン類（X_*, FEEDLY_API_TOKEN）は .env / GitHub Secrets に置く（このファイルには書かない）。
 */

export interface FeedsConfig {
  x: {
    /** 取得対象アカウントのユーザー名（@ なし）。例: "OpenAI" */
    username: string;
    /** users/:id/tweets で1回に取得する最大件数（5〜100） */
    maxResults: number;
    /** true の場合、X取得を完全にスキップ（認証情報が無いとき用） */
    disabled?: boolean;
  };
  feedly: {
    /** "user/<userId>/category/<categoryName>" 形式の streamId */
    streamId: string;
    /** 1回に取得する記事数 */
    count: number;
    disabled?: boolean;
  };
  hatena: {
    /** はてなブックマーク 人気エントリー テクノロジー の RSS */
    rssUrl: string;
    disabled?: boolean;
  };
  /** 集約後、保持する最大件数 */
  maxItems: number;
  /** 集約後、この日数より古いアイテムは捨てる */
  maxAgeDays: number;
}

export const feedsConfig: FeedsConfig = {
  x: {
    username: "satory074", // 自分のアカウント = Owned Read ($0.001/件)
    maxResults: 20,
    disabled: false,
  },
  feedly: {
    streamId:
      "user/25e9a004-74fc-4204-9c66-0e1687f69f73/category/fcda305b-0f50-44d9-a1da-689b3d1fe43a",
    count: 30,
    disabled: false,
  },
  hatena: {
    rssUrl: "https://b.hatena.ne.jp/hotentry/it.rss",
    disabled: false,
  },
  maxItems: 200,
  maxAgeDays: 30,
};
