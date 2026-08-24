// 構造式SVGの検問。描いてよければ整えたSVGを、駄目なら空文字を返す。
//
// このSVGはKetcher（public/ketcher/editor.html）が自分で作ってDBへ入れたものなので、
// 素性は分かっている。とはいえDBの中身を無検査でHTMLとして描くのは筋が悪いので、
// スクリプトを持ち込める形をしていたら描かない（構造式が出ないだけで、行は普通に使える）。
// 古い行にはXML宣言つきのSVGが入っていることがあるので、<svg から始まる形に削ってから見る。
// サーバ側（src/api/report.mjs の safeSvg）と同じ判定。
//
// 反応テーブル・試薬マスタ・試薬マスタの検索モーダルの3か所から使うので、
// どれか1つのコンポーネントに置かず、ここに独立させてある。
export function safeSvg(value: string): string {
  const text = String(value ?? '');
  const at = text.indexOf('<svg');
  if (at < 0) return '';
  const before = text.slice(0, at).replace(/<\?xml[^>]*\?>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  if (/[^\s]/.test(before)) return '';
  const svg = text.slice(at).trim();
  if (/<script|<foreignObject|javascript:|\son\w+\s*=/i.test(svg)) return '';
  return svg;
}
