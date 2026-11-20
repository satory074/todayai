/**
 * 機械翻訳／生成AI要約によるアイテム本文の日本語補完。
 *
 * enrichArticles.ts と同じ「state に永続キャッシュ・毎回アイテムへ再適用・トリム後の
 * 最終アイテムだけ対象・未確認のみ API」パターン。X bookmark / 記事系 等は毎回
 * フレッシュ取得され titleJa/summaryJa を失うが、transCache（state.translations）から
 * 再適用するので再生成しない。
 *
 * - title: 原文が非日本語なら自然な日本語に翻訳（titleJa）。日本語ならスキップ。
 * - summary: `summarizeSources`（記事系）は原文の言語によらず **3行要約**（summaryJa）。
 *   それ以外（X 等）は従来どおり summary を翻訳（非日本語のときのみ）。
 *
 * Gemini REST API（generateContent）を fetch のみで叩く（layerx.ts と同方式・依存追加なし）。
 * responseMimeType=application/json + responseSchema で配列 JSON を堅牢に受け取る。
 * バッチ失敗（network / parse / 件数不一致）はそのバッチをスキップし run 全体は落とさない。
 */
import type { FeedItem, FeedSource } from "../../src/lib/feed";
import { mapLimit } from "./util";

export interface TranslateOptions {
  model: string;
  batchSize: number;
  concurrency: number;
  /** 概要を翻訳ではなく3行要約にするソース（記事系）。 */
  summarizeSources: FeedSource[];
  /** この文字数未満の summary は要約せず翻訳扱い。 */
  summaryMinLen: number;
  /**
   * true なら「翻訳」のキャッシュ（titleJa・要約対象外ソースの summaryJa・リンクカード訳）を捨てて
   * 作り直す。記事系の3行要約（summaryJa）は残す＝記事本文の再取得も要約のやり直しもしない。
   * aggregate.ts の TRANSLATE_VERSION が state と違うときに立つ。
   */
  resetTranslations?: boolean;
}

export interface TranslateResult {
  /** 今回新たに翻訳できた件数 */
  translated: number;
  /** 今回 API 翻訳を試みた件数 */
  attempted: number;
  /** 実行したバッチ数 */
  batches: number;
}

/** かな・カタカナ・漢字を含めば日本語とみなす（翻訳不要）。 */
export function isJapanese(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿]/.test(text);
}

interface TransCacheEntry {
  titleJa?: string;
  summaryJa?: string;
  /** linkPreview.title の日本語訳（X リンクカード） */
  linkTitleJa?: string;
  /** linkPreview.description の日本語訳 */
  linkDescJa?: string;
}

/** 末尾/文中の t.co を除去（生 URL の誤翻訳・無駄を防ぐ）。X 本文向け。 */
function stripTco(text: string): string {
  return text.replace(/\s*https?:\/\/t\.co\/\S+/g, "").trim();
}

/** 翻訳/要約の対象アイテムと、要約/翻訳の入力テキスト・処理種別。 */
interface Target {
  item: FeedItem;
  /** true=入力を3行要約 / false=入力を翻訳 */
  summarize: boolean;
  /** 翻訳する title（t.co 除去済み）。空なら title 翻訳不要 */
  titleInput: string;
  /** 処理対象テキスト。要約=本文(contentText)優先・翻訳=summary（抜粋・t.co除去）。空なら不要 */
  input: string;
  /** linkPreview.title（非日本語・未翻訳のみ）。空なら不要 */
  linkTitle: string;
  /** linkPreview.description（非日本語・未翻訳のみ）。空なら不要 */
  linkDesc: string;
}

/**
 * `items` のうち翻訳/要約が必要な（キャッシュ無し）ものを Gemini で日本語化する。
 * transCache を参照して既知分は流用、未確認のみ処理する。transCache は破壊的に更新される
 * （呼び出し側で state に保存する）。
 */
export async function enrichTranslations(
  items: FeedItem[],
  transCache: Record<string, TransCacheEntry>,
  apiKey: string,
  opts: TranslateOptions,
): Promise<TranslateResult> {
  const summSet = new Set(opts.summarizeSources);

  // 欄ごとに「訳が要るか」を決め、キャッシュに無い欄だけ API へ送る。
  // 要らない欄（日本語タイトル等）の訳はキャッシュにあっても捨てる。かつてはモデルが空欄に
  // 勝手な見出しを入れて返し、それを採用していた（日本語タイトルの書き換え・X 本文の差し替え）。
  const targets: Target[] = [];
  for (const item of items) {
    const isSummSrc = summSet.has(item.source);
    let cached = transCache[item.id];
    if (cached && opts.resetTranslations) {
      // 3行要約だけ残す（翻訳は作り直す）。
      cached = transCache[item.id] =
        isSummSrc && cached.summaryJa ? { summaryJa: cached.summaryJa } : {};
    }
    const c: TransCacheEntry = cached ?? {};

    // X は本文に t.co を含み得る。翻訳入力からは t.co を除去（生 URL の誤翻訳を防ぐ）。
    const titleInput = stripTco(item.title ?? "");
    const summary = item.summary?.trim() ?? "";
    // 要約は記事本文（enrichArticles が付ける contentText）を優先、無ければ抜粋。
    const body = item.contentText?.trim() || summary;
    // 記事系 & 十分な長さの本文/抜粋 → 3行要約（日本語記事も対象）。その他 → 翻訳。
    const summarize = isSummSrc && body.length >= opts.summaryMinLen;
    const summaryInput = summarize ? body : stripTco(summary);
    const lp = item.linkPreview;

    const wantTitle = !!titleInput && !isJapanese(titleInput);
    const wantSummary = summarize || (summaryInput.length > 0 && !isJapanese(summaryInput));
    const wantLinkTitle = !!lp?.title && !isJapanese(lp.title);
    const wantLinkDesc = !!lp?.description && !isJapanese(lp.description);

    // 要らない欄の訳を捨てる。記事系の summaryJa は残す（キャッシュ済みの項目は本文を取り直さない
    // ので、ここでの want 判定が要約時と食い違い得る＝要約を誤って消さない）。
    if (!wantTitle) delete c.titleJa;
    if (!isSummSrc && !wantSummary) delete c.summaryJa;
    if (!wantLinkTitle) delete c.linkTitleJa;
    if (!wantLinkDesc) delete c.linkDescJa;

    // 表示用フィールドはキャッシュに合わせる（前回の feed.json から持ち越した古い訳を残さない）。
    if (c.titleJa) item.titleJa = c.titleJa;
    else delete item.titleJa;
    if (c.summaryJa) item.summaryJa = c.summaryJa;
    else delete item.summaryJa;
    if (lp) {
      if (c.linkTitleJa) lp.titleJa = c.linkTitleJa;
      else delete lp.titleJa;
      if (c.linkDescJa) lp.descriptionJa = c.linkDescJa;
      else delete lp.descriptionJa;
    }

    // linkPreview は本文と別ライフサイクル（maxNew で後から解決され得る）ので欄ごとに判定する。
    const needTitle = wantTitle && !c.titleJa;
    const needSummary = wantSummary && !c.summaryJa;
    const linkTitle = wantLinkTitle && !c.linkTitleJa ? lp!.title! : "";
    const linkDesc = wantLinkDesc && !c.linkDescJa ? lp!.description! : "";
    if (!needTitle && !needSummary && !linkTitle && !linkDesc) continue;
    targets.push({
      item,
      summarize: needSummary && summarize,
      titleInput: needTitle ? titleInput : "",
      input: needSummary ? summaryInput : "",
      linkTitle,
      linkDesc,
    });
  }

  // バッチに分割
  const batches: Target[][] = [];
  for (let i = 0; i < targets.length; i += opts.batchSize) {
    batches.push(targets.slice(i, i + opts.batchSize));
  }

  let translated = 0;
  await mapLimit(batches, opts.concurrency, async (batch) => {
    const out = await translateBatch(batch, apiKey, opts.model);
    if (!out) return; // バッチ失敗 → 次回 run で再試行
    for (let i = 0; i < batch.length; i++) {
      const { item, titleInput, input, linkTitle, linkDesc } = batch[i];
      const t = out[i];
      if (!t) continue;
      // 頼んだ欄だけ採用する。空で送った欄にもモデルは何か入れて返すことがある
      // （日本語タイトルを要約した見出し、リンク先の題を X 本文の訳として返す等）。
      const pick = (asked: string, v?: string) => (asked ? v?.trim() || undefined : undefined);
      const titleJa = pick(titleInput, t.titleJa);
      const summaryJa = pick(input, t.summaryJa);
      const linkTitleJa = pick(linkTitle, t.linkTitleJa);
      const linkDescJa = pick(linkDesc, t.linkDescJa);
      if (!titleJa && !summaryJa && !linkTitleJa && !linkDescJa) continue;
      if (titleJa) item.titleJa = titleJa;
      if (summaryJa) item.summaryJa = summaryJa;
      if (item.linkPreview) {
        if (linkTitleJa) item.linkPreview.titleJa = linkTitleJa;
        if (linkDescJa) item.linkPreview.descriptionJa = linkDescJa;
      }
      // 既存キャッシュにマージ（link だけ後から足すケースで title/summary 訳を失わない）。
      const prev = transCache[item.id] ?? {};
      transCache[item.id] = {
        titleJa: titleJa ?? prev.titleJa,
        summaryJa: summaryJa ?? prev.summaryJa,
        linkTitleJa: linkTitleJa ?? prev.linkTitleJa,
        linkDescJa: linkDescJa ?? prev.linkDescJa,
      };
      translated++;
    }
  });

  return { translated, attempted: targets.length, batches: batches.length };
}

interface BatchTranslation {
  titleJa: string;
  summaryJa?: string;
  linkTitleJa?: string;
  linkDescJa?: string;
}

/** 1バッチを Gemini で翻訳/要約。失敗時は null（呼び出し側でスキップ）。 */
async function translateBatch(
  batch: Target[],
  apiKey: string,
  model: string,
): Promise<BatchTranslation[] | null> {
  const entries = batch.map(({ titleInput, input, summarize, linkTitle, linkDesc }, i) => ({
    i,
    title: titleInput,
    body: input,
    summarize,
    linkTitle,
    linkDesc,
  }));

  const prompt =
    "次の配列の各エントリを処理し、{titleJa, summaryJa, linkTitleJa, linkDescJa} を返してください。\n" +
    "・titleJa: title を自然な日本語に翻訳。要約・省略・言い換えはせず、原文の文と情報をすべて残す（見出しらしく縮めない）。\n" +
    "・summaryJa:\n" +
    "    summarize が true → body（記事本文）の要点を一読でつかめる日本語の要約にする:\n" +
    "      - 最重要の要点を結論から1つ書く。複数トピックの記事でも要点を1〜2点に絞り、網羅的に列挙しない。\n" +
    "      - 前置き・宣伝文句・筆者の感想は省き、事実だけを書く。タイトルの言い換えで終わらせない。\n" +
    "      - 最大2文・100字以内。やさしい言葉と短い文で必ず言い切る。本文に無い情報は足さない。\n" +
    "    summarize が false → body を自然な日本語に翻訳（要約・省略しない）。\n" +
    "・linkTitleJa: linkTitle（リンク先の見出し）を自然な日本語に翻訳。\n" +
    "・linkDescJa: linkDesc（リンク先の説明）を自然な日本語に翻訳。\n" +
    "各出力は対応する入力（title / body / linkTitle / linkDesc）だけから作ってください。入力が空文字なら、その出力も必ず空文字にします（他の欄の内容を流用したり推測で補ったりしない）。\n" +
    "技術用語・製品名・固有名詞は無理に訳さず一般的な表記を使い、意味を保ってください。\n" +
    "入力と同じ順序・同じ件数で、各要素 {titleJa, summaryJa, linkTitleJa, linkDescJa} の JSON 配列のみを返してください。\n\n" +
    JSON.stringify(entries);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            titleJa: { type: "STRING" },
            summaryJa: { type: "STRING" },
            linkTitleJa: { type: "STRING" },
            linkDescJa: { type: "STRING" },
          },
          required: ["titleJa"],
        },
      },
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[translate] Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as BatchTranslation[];
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      console.error(
        `[translate] 件数不一致（in ${batch.length} / out ${Array.isArray(parsed) ? parsed.length : "?"}）`,
      );
      return null;
    }
    return parsed;
  } catch (e) {
    console.error("[translate] バッチ失敗:", (e as Error).message);
    return null;
  }
}
