// 構造式の枠1つぶん。反応テーブル・試薬マスタ・試薬ピッカー・在庫の4か所から使う。
//
// 【何を出すかの優先順位】
//   1. svg      … Ketcherで描いて保存したもの。人が整えた配置なので最優先（RDKitで上書きしない）
//   2. molfile  … 座標つきの構造。RDKitに描かせる
//   3. smiles   … PubChem補完・溶媒プリセット・マスタ挿入で入る。RDKitに描かせる
//   4. どれも無い … プレースホルダ（編集できる場所なら「構造式を描く」ボタン）
//
// RDKitは7MB弱のWebAssemblyなので、2か3に落ちて初めて読み込む（rdkit.ts の遅延初期化）。
// 読み込んでいるあいだは骨組みだけ出す。読めなかった・描けなかったときは黙って4に戻る。
import { useEffect, useState, type ReactNode } from 'react';
import { safeSvg } from './safeSvg.ts';
import { drawStructure, drawStructureSync, hasStructureSource, type StructureSize } from './rdkit.ts';

interface Props {
  // Ketcherが保存したSVG（あればこれを出す）
  svg?: string;
  smiles?: string;
  molfile?: string;
  // thumb=表のセル / large=フォームの見本。描く解像度が変わるだけで、枠の大きさはCSSが決める
  size?: StructureSize;
  // 読み上げ・ツールチップ用の名前（普通は試薬名）
  alt?: string;
  // 構造式が1つも無いときに枠へ入れるもの（既定は「—」）
  fallback?: ReactNode;
  // 渡すと押せる枠（＝構造式エディタを開くボタン）になる。省略すると見るだけの枠
  onClick?: () => void;
  title?: string;
  // 枠の土台クラス。既定は表のセル用（.structure-slot）。
  // 試薬ピッカーだけは寸法が違うので .picker-structure を渡す。
  // 状態クラス（structure-drawn / structure-empty / structure-loading）は常に後ろへ付く
  className?: string;
}

// 保存済みSVG → RDKit描画 の順に「今出せるSVG」を決める。
// 返り値が null のあいだは読み込み中（RDKitの起動待ち）
function useStructureSvg(svg: string, smiles: string, molfile: string, size: StructureSize): string | null {
  const saved = safeSvg(svg);
  const source = { smiles, molfile };
  // 保存済みがあるならRDKitは呼ばない。起動待ちも起きない
  const immediate = saved ? saved : drawStructureSync(source, size);
  const [drawn, setDrawn] = useState<string | null>(immediate);

  useEffect(() => {
    if (saved) { setDrawn(saved); return; }
    if (!hasStructureSource(source)) { setDrawn(''); return; }
    const sync = drawStructureSync(source, size);
    if (sync !== null) { setDrawn(sync); return; }
    // ここで初めてRDKitを起動する。待っているあいだに行が消えても書き戻さない
    let alive = true;
    setDrawn(null);
    void drawStructure(source, size).then((result) => { if (alive) setDrawn(result); });
    return () => { alive = false; };
    // sourceは毎回作り直す小さなオブジェクトなので、依存には中身（文字列）を並べる
  }, [saved, smiles, molfile, size]);

  return drawn;
}

export function MoleculeStructure({
  svg = '', smiles = '', molfile = '', size = 'thumb', alt, fallback, onClick, title,
  className: base = 'structure-slot',
}: Props) {
  const drawn = useStructureSvg(svg, smiles, molfile, size);
  const label = (alt ?? '').trim();

  // 中身と見た目（枠線）だけを決めて、要素の種類は最後にまとめて決める
  let className = `${base} `;
  let inner: ReactNode = null;
  let html: string | null = null;

  if (drawn === null) {
    className += 'structure-loading';
    inner = <span className="structure-skeleton" aria-hidden="true" />;
  } else if (drawn) {
    className += 'structure-drawn';
    html = drawn;
  } else {
    className += 'structure-empty';
    inner = fallback ?? '—';
  }

  const tip = title ?? (label || undefined);
  const ariaLabel = label && title ? `${label} ${title}` : undefined;

  // 描画対象のSVGは、保存済みもRDKit製も safeSvg() を通したものだけ（rdkit.ts でも通している）
  if (html !== null) {
    return onClick
      ? (
        <button type="button" className={className} title={tip} aria-label={ariaLabel}
          onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      )
      : <span className={className} title={tip} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return onClick
    ? (
      <button type="button" className={className} title={tip} aria-label={ariaLabel} onClick={onClick}>
        {inner}
      </button>
    )
    : <span className={className} title={tip}>{inner}</span>;
}
