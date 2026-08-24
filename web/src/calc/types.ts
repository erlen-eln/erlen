// reactionCalculator.ts / molCalculator.ts が参照する型。
// この2本は姉妹アプリ（elnectmobile）から無改修で持ってきているので、
// 元コードが `import type { Molecule } from '../types'` としていた型をここに置き直している。
// 中身はこの製品のD1スキーマ（migrations/0001_init.sql の molecules テーブル）に合わせた。
//
// 単位の約束（画面・計算・DBで共通）
//   molecular_weight  g/mol
//   density           g/mL
//   purity            %（0〜100）
//   equivalents       当量（基準物質＝1.0）
//   mass              mg
//   moles             mmol
//   volume            mL
//   molarity          mol/L
//   yield_percent     %

export type MoleculeRole = 'reactant' | 'product';

export interface Molecule {
  id: string;
  role: MoleculeRole;
  name: string;
  smiles: string;
  // 構造式。molfileが正本（Ketcherへ描き戻せる形）で、svgは表に出すための描画済みの絵。
  // どちらもKetcher（public/ketcher/editor.html）が作る。手で書き換えることは想定しない。
  molfile: string;
  svg: string;
  cas_number: string;
  molecular_weight: number | null;
  density: number | null;
  purity: number | null;
  equivalents: number | null;
  mass: number | null;
  moles: number | null;
  volume: number | null;
  molarity: number | null;
  is_reference: boolean;
  yield_percent: number | null;
  sort_order: number;
}

// molCalculator.ts が使う、1化合物ぶんの計算箱
export interface MolCalculation {
  molecularWeight: number | null;
  density: number | null;
  purity: number | null;
  mass: number | null;
  volume: number | null;
  mol: number | null;
  mmol: number | null;
}
