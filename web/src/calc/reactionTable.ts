// 反応テーブルの「表としての振る舞い」。
// 1化合物ぶんの換算は reactionCalculator.ts（姉妹アプリからの無改修コピー）に任せ、
// ここは表全体の都合だけを持つ。
//   ・基準物質（Eq.=1.0の軸）を1行だけに保つ
//   ・基準の mmol が動いたら、他の原料を当量から引き直す
//   ・生成物の収率を基準物質の mmol から自動で出す
//   ・行の追加・削除・並び替え
// UI（React）には一切依存しない純関数だけを置く。だから test/reaction-calc.test.mjs から
// そのまま呼んで検証できる。
import type { Molecule, MoleculeRole } from './types.ts';
import {
  calculateFromField, recalculateMolecules, type CalculationField,
} from './reactionCalculator.ts';

// 数値として編集する列のうち、換算の軸になれるもの
const CALC_FIELDS: CalculationField[] = ['mass', 'moles', 'volume', 'equivalents'];

// 物性の列。ここを直したら、生きている入力を軸にして換算し直す
const PROPERTY_FIELDS = ['molecular_weight', 'density', 'purity', 'molarity'] as const;

export type NumericField = CalculationField | (typeof PROPERTY_FIELDS)[number] | 'yield_percent';
export type TextField = 'name' | 'cas_number' | 'smiles';
export type EditableField = NumericField | TextField;

export function isCalcField(field: string): field is CalculationField {
  return (CALC_FIELDS as string[]).includes(field);
}

export function isPropertyField(field: string): boolean {
  return (PROPERTY_FIELDS as readonly string[]).includes(field);
}

// 空行。新規行の既定値（純度100%・当量1.0）はDB側の既定と揃えてある
export function emptyRow(role: MoleculeRole, sortOrder: number, id: string): Molecule {
  return {
    id,
    role,
    name: '',
    smiles: '',
    molfile: '',
    svg: '',
    cas_number: '',
    molecular_weight: null,
    density: null,
    purity: 100,
    equivalents: role === 'reactant' ? 1 : null,
    mass: null,
    moles: null,
    volume: null,
    molarity: null,
    is_reference: false,
    yield_percent: null,
    sort_order: sortOrder,
  };
}

// 基準物質。原料のうち is_reference が立っている最初の1行（無ければnull）
export function findReference(rows: Molecule[]): Molecule | null {
  return rows.find((r) => r.role === 'reactant' && r.is_reference) ?? null;
}

// 基準物質の mmol。これが決まらないと当量も収率も出せない
export function referenceMoles(rows: Molecule[]): number | null {
  const ref = findReference(rows);
  if (!ref || ref.moles === null || ref.moles <= 0) return null;
  return ref.moles;
}

// 1行ぶんの換算。changedField を軸に、他の欄を追随させる
function recomputeRow(row: Molecule, axis: CalculationField, refMoles: number | null): Molecule {
  const result = calculateFromField({
    molecularWeight: row.molecular_weight,
    density: row.density,
    purity: row.purity,
    equivalents: row.equivalents,
    mass: row.mass,
    moles: row.moles,
    volume: row.volume,
    molarity: row.molarity,
  }, axis, refMoles);
  return {
    ...row,
    equivalents: result.equivalents,
    mass: result.mass,
    moles: result.moles,
    volume: result.volume,
  };
}

// 物性（分子量・密度・純度・濃度）を直したときに、どの入力を軸として引き直すか。
// 残すべきは「利用者が自分で打った数字」なので、分かっていればそれ（axisHint）を最優先する。
//   例1 当量を打ってある行の純度を80%に直す → 当量はそのまま、量る質量が増える（仕込みの計画）
//   例2 質量を打ってある行の純度を80%に直す → 質量はそのまま、有効なmmolが減る（量った実績）
// 手がかりが無いとき（ページを開き直した直後など）は、基準がある行は当量を、
// それ以外は 質量→体積→mmol の順で軸にする。
function anchorField(
  row: Molecule,
  isReference: boolean,
  refMoles: number | null,
  axisHint?: CalculationField
): CalculationField | null {
  if (axisHint && (axisHint !== 'equivalents' || (!isReference && refMoles !== null))) return axisHint;
  if (!isReference && refMoles !== null && row.equivalents !== null) return 'equivalents';
  if (row.mass !== null) return 'mass';
  if (row.volume !== null) return 'volume';
  if (row.moles !== null) return 'moles';
  return null;
}

// 生成物の収率。理論収量は基準物質（＝律速の原料）の mmol とし、1:1で反応する前提で出す。
// 化学量論比が1:1でない反応では、生成物の当量欄に係数を入れて読み替える運用にする。
export function withYields(rows: Molecule[]): Molecule[] {
  const refMoles = referenceMoles(rows);
  return rows.map((row) => {
    if (row.role !== 'product') return row;
    if (refMoles === null || row.moles === null) return row;
    return { ...row, yield_percent: (row.moles / refMoles) * 100 };
  });
}

// 基準物質から原料全体へ当量を伝播させる。
// 生成物は「実際に採れた量」なので、ここでは動かさない。
export function propagateFromReference(rows: Molecule[]): Molecule[] {
  const ref = findReference(rows);
  if (!ref || ref.moles === null || ref.moles === 0) return rows;
  const reactants = rows.filter((r) => r.role === 'reactant');
  const recalculated = recalculateMolecules(reactants, ref);
  const byId = new Map(recalculated.map((r) => [r.id, r]));
  return rows.map((r) => byId.get(r.id) ?? r);
}

// 表の整合を取る仕上げ。基準行の当量は必ず1.0、生成物の収率は再計算
function finalize(rows: Molecule[]): Molecule[] {
  const ref = findReference(rows);
  const fixed = ref
    ? rows.map((r) => (r.id === ref.id ? { ...r, equivalents: 1 } : r))
    : rows;
  return withYields(fixed);
}

// セルを1つ編集したときの表全体の更新。これが反応テーブルの中核。
//   1. 編集した値を入れる
//   2. その行を換算し直す（軸は編集した列そのもの／物性なら anchorField が決める）
//   3. 基準行を触ったなら、他の原料へ当量から伝播させる
//   4. 基準行の当量を1.0に固定し、生成物の収率を出し直す
// axisHint には「その行で利用者が最後に打った数値の列」を渡す（画面側が覚えている）。
export function applyEdit(
  rows: Molecule[],
  id: string,
  field: EditableField,
  value: string | number | null,
  axisHint?: CalculationField
): Molecule[] {
  let next = rows.map((r) => (r.id === id ? { ...r, [field]: value } as Molecule : r));
  const target = next.find((r) => r.id === id);
  if (!target) return rows;

  const isRef = findReference(next)?.id === id;
  // 基準行そのものを編集しているときは、自分の当量を自分から計算しないよう refMoles を渡さない
  const refMoles = isRef ? null : referenceMoles(next);

  let axis: CalculationField | null = null;
  if (isCalcField(field)) axis = field;
  else if (isPropertyField(field)) axis = anchorField(target, isRef, refMoles, axisHint);

  if (axis) {
    const recomputed = recomputeRow(target, axis, refMoles);
    next = next.map((r) => (r.id === id ? recomputed : r));
    // 基準の mmol が動いたら、他の原料はその当量ぶんに追随する
    if (isRef) next = propagateFromReference(next);
  }
  return finalize(next);
}

// 基準物質の付け替え。基準は常に原料の中の1行だけ
export function setReference(rows: Molecule[], id: string): Molecule[] {
  const next = rows.map((r) => ({
    ...r,
    is_reference: r.role === 'reactant' && r.id === id,
  }));
  return finalize(propagateFromReference(next));
}

// 原料↔生成物の切り替え。生成物になった行は基準を外す（基準は原料の中から選ぶ）
export function setRole(rows: Molecule[], id: string, role: MoleculeRole): Molecule[] {
  const next = rows.map((r) => (
    r.id === id ? { ...r, role, is_reference: role === 'reactant' ? r.is_reference : false } : r
  ));
  return finalize(next);
}

// 行の追加。同じ役割（原料/生成物）の末尾へ置く。
// 原料が1行も無いところへ足す1行目は、そのまま基準物質にしてしまう（大抵それが正しい）
export function addRow(rows: Molecule[], role: MoleculeRole, id: string): Molecule[] {
  const sortOrder = rows.length ? Math.max(...rows.map((r) => r.sort_order)) + 1 : 0;
  const row = emptyRow(role, sortOrder, id);
  if (role === 'reactant' && !findReference(rows)) row.is_reference = true;
  return finalize([...rows, row]);
}

export function removeRow(rows: Molecule[], id: string): Molecule[] {
  const next = rows.filter((r) => r.id !== id);
  // 基準を消してしまったら、残った原料の先頭を基準に繰り上げる
  if (!findReference(next)) {
    const firstReactant = next.find((r) => r.role === 'reactant');
    if (firstReactant) return setReference(next, firstReactant.id);
  }
  return finalize(next);
}

// 同じ役割（原料どうし・生成物どうし）の中で1つ上／下へ入れ替える。
// 入れ替えたあとは原料→生成物の通し番号で sort_order を0から振り直すので、
// 保存した並びがそのまま次回の表示順になる。
export function moveRow(rows: Molecule[], id: string, direction: -1 | 1): Molecule[] {
  const target = rows.find((r) => r.id === id);
  if (!target) return rows;
  const ordered = sortRows(rows);
  const reactants = ordered.filter((r) => r.role === 'reactant');
  const products = ordered.filter((r) => r.role === 'product');
  const group = target.role === 'reactant' ? reactants : products;

  const index = group.findIndex((r) => r.id === id);
  const swapWith = index + direction;
  if (swapWith < 0 || swapWith >= group.length) return rows; // 端では動かない
  [group[index], group[swapWith]] = [group[swapWith], group[index]];

  return [...reactants, ...products].map((r, i) => ({ ...r, sort_order: i }));
}

// 表の並び（原料が先・その中はsort_order順）
export function sortRows(rows: Molecule[]): Molecule[] {
  return [...rows].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'reactant' ? -1 : 1;
    return a.sort_order - b.sort_order;
  });
}

// 表示用の丸め。桁が飛んでも読めるように、値の大きさで小数点以下を変える
export function displayNumber(value: number | null, unitDecimals = 3): string {
  if (value === null || !Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 1) return trimZeros(value.toFixed(unitDecimals));
  return trimZeros(value.toPrecision(3));
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}
