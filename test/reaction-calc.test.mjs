// 反応計算の検査。実験ノートで一番間違えてはいけないところなので、手計算と突き合わせる。
//
// 【方式】web/src/calc/*.ts を **そのまま** import している。
// Node 22.18 以降（本開発機は Node 24）は TypeScript の型注釈を実行時に剥がして読めるので、
// ビルドもトランスパイルも挟まずに、画面が使うのと同一のコードを検証できる。
// もし古いNodeで動かした場合は、この1ファイルだけ丸ごとスキップして残りは通す。
import test from 'node:test';
import assert from 'node:assert/strict';

// 型ストリップが効かないNodeでは import 自体が落ちる。落ちたらスキップに倒す
let calc;
let table;
let importError = null;
try {
  calc = await import('../web/src/calc/reactionCalculator.ts');
  table = await import('../web/src/calc/reactionTable.ts');
} catch (e) {
  importError = e;
}
const skip = importError
  ? `Nodeが .ts を直接読めません（Node 22.18以降が必要）: ${importError.message}`
  : false;

// 小数の突き合わせ。有効数字6桁で見る
function near(actual, expected, message) {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < Math.abs(expected) * 1e-6 + 1e-9,
    `${message ?? ''} 期待 ${expected} / 実際 ${actual}`
  );
}

let seq = 0;
function row(overrides = {}) {
  seq += 1;
  return {
    id: `row-${seq}`,
    role: 'reactant',
    name: '',
    smiles: '',
    cas_number: '',
    molecular_weight: null,
    density: null,
    purity: 100,
    equivalents: 1,
    mass: null,
    moles: null,
    volume: null,
    molarity: null,
    is_reference: false,
    yield_percent: null,
    sort_order: seq,
    ...overrides,
  };
}

// ---- 単位換算（reactionCalculator.ts をそのまま） -----------------------

test('質量→mmol・mmol→質量（mg / g/mol / mmol の組み合わせ）', { skip }, () => {
  // 安息香酸 122.12 g/mol を 122.12 mg 量ったら 1.000 mmol
  near(calc.calculateMolesFromMass(122.12, 122.12), 1, '122.12mg / 122.12g/mol');
  near(calc.calculateMassFromMoles(1, 122.12), 122.12, '1mmol × 122.12g/mol');
  // 純度95%の試薬を122.12mg量っても、有効なのは0.95mmol
  near(calc.calculateMolesFromMass(122.12, 122.12, 95), 0.95, '純度補正');
  // 逆向き: 1mmol必要なら、純度95%の粉は128.5mg量る
  near(calc.calculateMassFromMoles(1, 122.12, 95), 122.12 / 0.95, '純度ぶん多く量る');
});

test('質量↔体積（密度）とmmol↔体積（モル濃度）', { skip }, () => {
  // 密度0.789 g/mL のエタノール 789 mg は 1.00 mL
  near(calc.calculateVolumeFromMass(789, 0.789), 1);
  near(calc.calculateMassFromVolume(1, 0.789), 789);
  // 1 mol/L の溶液から 2 mmol 取るには 2 mL
  near(calc.calculateVolumeFromMolesAndMolarity(2, 1), 2);
  near(calc.calculateMolesFromVolumeAndMolarity(2, 1), 2);
});

test('当量は基準物質のmmolとの比', { skip }, () => {
  near(calc.calculateEquivalents(3, 1.5), 2);
  near(calc.calculateMolesFromEquivalents(2, 1.5), 3);
  assert.equal(calc.calculateEquivalents(3, 0), 0, '基準が0なら0（0除算を出さない）');
});

test('calculateFromField: 編集した欄を軸に他が埋まる', { skip }, () => {
  const input = {
    molecularWeight: 122.12, density: null, purity: 100,
    equivalents: null, mass: null, moles: null, volume: null, molarity: null,
  };

  // 質量を打った → mmolと当量（基準1.0mmolに対して）が出る
  const byMass = calc.calculateFromField({ ...input, mass: 244.24 }, 'mass', 1);
  near(byMass.moles, 2);
  near(byMass.equivalents, 2);

  // 当量を打った → mmolと質量が出る
  const byEq = calc.calculateFromField({ ...input, equivalents: 1.5 }, 'equivalents', 2);
  near(byEq.moles, 3);
  near(byEq.mass, 3 * 122.12);

  // 液体（密度あり）は体積も出る
  const liquid = calc.calculateFromField(
    { ...input, molecularWeight: 46.07, density: 0.789, equivalents: 2 }, 'equivalents', 1
  );
  near(liquid.moles, 2);
  near(liquid.mass, 2 * 46.07);
  near(liquid.volume, (2 * 46.07) / (0.789 * 1000));

  // 溶液（モル濃度あり）は体積が濃度から出る
  const solution = calc.calculateFromField(
    { ...input, molarity: 2, equivalents: 1 }, 'equivalents', 3
  );
  near(solution.moles, 3);
  near(solution.volume, 1.5, '3 mmol ÷ 2 mol/L = 1.5 mL');

  // 体積を打った（密度あり）→ 質量とmmolが出る
  const byVolume = calc.calculateFromField(
    { ...input, molecularWeight: 46.07, density: 0.789, volume: 2 }, 'volume', null
  );
  near(byVolume.mass, 2 * 0.789 * 1000);
  near(byVolume.moles, (2 * 0.789 * 1000) / 46.07);
});

test('分子量が無い行は計算されない（推測しない）', { skip }, () => {
  const result = calc.calculateFromField({
    molecularWeight: null, density: null, purity: 100,
    equivalents: null, mass: 100, moles: null, volume: null, molarity: null,
  }, 'mass', 1);
  assert.equal(result.moles, null);
});

// ---- 表としての振る舞い（reactionTable.ts） -----------------------------

test('基準物質に質量を入れると、他の原料が当量ぶん自動で埋まる', { skip }, () => {
  const ref = row({ name: 'ベンズアルデヒド', molecular_weight: 106.12, is_reference: true });
  const other = row({ name: 'アセトン', molecular_weight: 58.08, equivalents: 3, density: 0.784 });
  let rows = [ref, other];

  // 基準に 1061.2 mg（＝10 mmol）
  rows = table.applyEdit(rows, ref.id, 'mass', 1061.2);
  const [r0, r1] = rows;
  near(r0.moles, 10, '基準のmmol');
  assert.equal(r0.equivalents, 1, '基準の当量は常に1.0');
  near(r1.moles, 30, '3当量ぶん');
  near(r1.mass, 30 * 58.08);
  near(r1.volume, (30 * 58.08) / (0.784 * 1000), '密度から体積も出る');
});

test('基準以外の当量を変えても、基準は動かない', { skip }, () => {
  const ref = row({ molecular_weight: 100, is_reference: true, mass: 1000 });
  const other = row({ molecular_weight: 50, equivalents: 1 });
  let rows = table.applyEdit([ref, other], ref.id, 'mass', 1000); // 基準 10 mmol
  rows = table.applyEdit(rows, other.id, 'equivalents', 2.5);

  near(rows[0].moles, 10, '基準は据え置き');
  assert.equal(rows[0].equivalents, 1);
  near(rows[1].moles, 25);
  near(rows[1].mass, 25 * 50);
});

test('生成物の質量を入れると収率が出る（基準のmmolを理論収量とする）', { skip }, () => {
  const ref = row({ molecular_weight: 106.12, is_reference: true });
  const product = row({ role: 'product', molecular_weight: 208.26, equivalents: null });
  let rows = table.applyEdit([ref, product], ref.id, 'moles', 10); // 基準 10 mmol

  // 生成物が 1457.8 mg 採れた → 7.0 mmol → 収率70%
  rows = table.applyEdit(rows, product.id, 'mass', 7 * 208.26);
  near(rows[1].moles, 7);
  near(rows[1].yield_percent, 70);

  // 基準の仕込み量を倍にすれば、同じ収量でも収率は半分になる
  rows = table.applyEdit(rows, ref.id, 'moles', 20);
  near(rows[1].yield_percent, 35);
});

test('純度を後から直すと、その行の質量が量り直される', { skip }, () => {
  const ref = row({ molecular_weight: 100, is_reference: true });
  const other = row({ molecular_weight: 200, equivalents: 1 });
  let rows = table.applyEdit([ref, other], ref.id, 'moles', 5);
  near(rows[1].mass, 5 * 200, '純度100%なら1000mg');

  rows = table.applyEdit(rows, other.id, 'purity', 80);
  near(rows[1].moles, 5, '必要なmmolは変わらない');
  near(rows[1].mass, (5 * 200) / 0.8, '純度80%なら1250mg量る');
});

test('純度の直しは「最後に打った列」を残す（axisHint）', { skip }, () => {
  const ref = row({ molecular_weight: 100, is_reference: true });
  const other = row({ molecular_weight: 200, equivalents: 1 });
  let rows = table.applyEdit([ref, other], ref.id, 'moles', 5);

  // 質量を自分で打った行は、質量が実測値。純度を直すと有効なmmolの方が減る
  rows = table.applyEdit(rows, other.id, 'mass', 1000, 'mass');
  rows = table.applyEdit(rows, other.id, 'purity', 80, 'mass');
  near(rows[1].mass, 1000, '量った質量はそのまま');
  near(rows[1].moles, (1000 * 0.8) / 200, '有効なmmolが減る');
});

test('基準の付け替え・原料と生成物の入れ替え', { skip }, () => {
  const a = row({ molecular_weight: 100, is_reference: true, equivalents: 1 });
  const b = row({ molecular_weight: 100, equivalents: 2 });
  let rows = table.applyEdit([a, b], a.id, 'moles', 1); // a=1mmol, b=2mmol

  rows = table.setReference(rows, b.id);
  assert.equal(rows[0].is_reference, false);
  assert.equal(rows[1].is_reference, true);
  assert.equal(rows[1].equivalents, 1, '新しい基準の当量は1.0');
  assert.equal(table.referenceMoles(rows), 2, '基準のmmolはbの2mmol');

  // 生成物へ移すと基準は外れる
  const moved = table.setRole(rows, rows[1].id, 'product');
  assert.equal(moved[1].role, 'product');
  assert.equal(moved[1].is_reference, false);
});

test('行の追加・削除・並び替え', { skip }, () => {
  let rows = table.addRow([], 'reactant', 'a');
  assert.equal(rows[0].is_reference, true, '原料の1行目は自動で基準になる');
  assert.equal(rows[0].purity, 100);
  rows = table.addRow(rows, 'reactant', 'b');
  rows = table.addRow(rows, 'product', 'p');
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'p']);

  // 並び替え（sort_orderは原料→生成物の通し番号で振り直す）
  const moved = table.moveRow(rows, 'b', -1);
  assert.deepEqual(table.sortRows(moved).map((r) => r.id), ['b', 'a', 'p']);
  assert.deepEqual(table.sortRows(moved).map((r) => r.sort_order), [0, 1, 2]);
  // 端では動かない
  assert.deepEqual(table.moveRow(moved, 'b', -1).map((r) => r.id), moved.map((r) => r.id));

  // 基準を消したら、残った原料の先頭が基準に繰り上がる
  const removed = table.removeRow(rows, 'a');
  assert.equal(removed.length, 2);
  assert.equal(removed.find((r) => r.id === 'b').is_reference, true);
});

test('displayNumber: 桁が飛んでも読める形に丸める', { skip }, () => {
  assert.equal(table.displayNumber(null), '');
  assert.equal(table.displayNumber(0), '0');
  assert.equal(table.displayNumber(1061.2), '1061');
  assert.equal(table.displayNumber(1.5), '1.5');
  assert.equal(table.displayNumber(122.12), '122.12');
  assert.equal(table.displayNumber(0.0007891), '0.000789');
});
