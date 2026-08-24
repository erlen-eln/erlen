// 反応テーブル。実験ノートの中核。
// どのセルを直しても、reactionTable.ts（＝reactionCalculator.ts）が他のセルを追随させる。
//   基準物質に印 → その行の質量かmmolを入れる → 他の原料は当量から自動で埋まる
//   生成物の質量を入れる → 収率が出る
// 計算そのものはこのファイルに1行も書かない。表示と入力だけを持つ。
import { useRef, useState } from 'react';
import type { Molecule, MoleculeRole } from '../calc/types.ts';
import type { CalculationField } from '../calc/reactionCalculator.ts';
import {
  addRow, applyEdit, displayNumber, isCalcField, moveRow, removeRow, setReference, setRole, sortRows,
  type EditableField,
} from '../calc/reactionTable.ts';
import { api, type ReagentMaster } from '../api.ts';
import { KetcherModal, type StructureResult } from './KetcherModal.tsx';
import { ReagentPickerModal } from './ReagentPickerModal.tsx';
import { MoleculeStructure } from './MoleculeStructure.tsx';
import { buildStructureSvg } from './rdkit.ts';
import { t } from '../i18n.ts';

// PubChem照会の行ごとの状態
type LookupState = 'searching' | 'filled' | 'notfound';

// 狭い画面（960px未満）では表が「1分子＝1カード」に畳まれて <thead> が消える。
// そのとき各セルの上に出す見出しを data-label に持たせておく（描くのはCSSの ::before）。
// 表のヘッダでは単位を <span class="unit"> で改行しているが、カードでは括弧にまとめる。
function cellLabel(name: string, unit?: string): string {
  return unit ? `${name}（${unit}）` : name;
}

interface Props {
  rows: Molecule[];
  readOnly: boolean;
  onChange: (rows: Molecule[]) => void;
}

// 入力文字列を数値へ。空欄はnull（未測定を表す）、数字にならないものは無視してnull
function parseNumberInput(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

interface NumberCellProps {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled: boolean;
  label: string;
  width?: string;
}

// 数値セル。編集中は打った文字をそのまま残す（"1." や "0.0" が消えないように）。
// フォーカスが外れたら整形済みの値の表示に戻る。
function NumberCell({ value, onChange, disabled, label, width }: NumberCellProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="cell-input cell-num"
      style={width ? { width } : undefined}
      type="text"
      inputMode="decimal"
      aria-label={label}
      disabled={disabled}
      value={draft ?? displayNumber(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parseNumberInput(e.target.value));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

interface TextCellProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled: boolean;
  label: string;
  placeholder?: string;
}

function TextCell({ value, onChange, onBlur, disabled, label, placeholder }: TextCellProps) {
  return (
    <input
      className="cell-input"
      type="text"
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  );
}

// 構造式セル。
// 保存済みSVG（Ketcherで描いたもの）が最優先。無ければ molfile / SMILES からRDKitが描く。
// どちらも無いときだけ「構造式を描く」ボタンになる。
// 確定済みのページは見るだけなので、ボタンにせず絵（か「—」）を置く。
function StructureCell({ row, readOnly, onOpen }: {
  row: Molecule;
  readOnly: boolean;
  onOpen: () => void;
}) {
  const label = row.name.trim() || t('reaction.structure');
  // 何か素材があるなら押したときは「描き直す」、無いなら「これから描く」
  const has = Boolean(row.svg.trim() || row.molfile.trim() || row.smiles.trim());
  return (
    <MoleculeStructure
      svg={row.svg}
      molfile={row.molfile}
      smiles={row.smiles}
      alt={label}
      title={readOnly ? label : (has ? t('ketcher.edit') : t('ketcher.draw'))}
      fallback={readOnly ? '—' : t('ketcher.draw')}
      onClick={readOnly ? undefined : onOpen}
    />
  );
}

export function ReactionTable({ rows, readOnly, onChange }: Props) {
  // 行ID → PubChem照会の状態
  const [lookups, setLookups] = useState<Record<string, LookupState>>({});
  // 構造式エディタを開いている行のID（nullなら閉じている）
  const [editingId, setEditingId] = useState<string | null>(null);
  // 試薬マスタの検索モーダルを開いているか
  const [picking, setPicking] = useState(false);
  const ordered = sortRows(rows);
  const reactants = ordered.filter((r) => r.role === 'reactant');
  const products = ordered.filter((r) => r.role === 'product');

  // 行ごとに「利用者が最後に打った数値の列」を覚えておく。
  // あとから分子量や純度を直したときに、打った数字の方を残して他を引き直すため
  const lastAxis = useRef<Record<string, CalculationField>>({});

  const edit = (id: string, field: EditableField, value: string | number | null) => {
    if (isCalcField(field)) lastAxis.current[id] = field;
    onChange(applyEdit(rows, id, field, value, lastAxis.current[id]));
  };

  const setLookup = (id: string, value: LookupState | null) => {
    setLookups((prev) => {
      const next = { ...prev };
      if (value === null) delete next[id];
      else next[id] = value;
      return next;
    });
  };

  // 名前・CAS欄からフォーカスが外れたらPubChemへ照会し、空いている欄だけ埋める。
  // 既に入っている値は絶対に上書きしない（利用者が実測した純度や分子量を消さないため）。
  const lookupPubChem = async (row: Molecule, type: 'cas' | 'name') => {
    if (readOnly) return;
    const query = (type === 'cas' ? row.cas_number : row.name).trim();
    if (!query) return;
    // 埋める先が全部埋まっているなら照会しない（無駄な外部アクセスを増やさない）
    if (row.molecular_weight !== null && row.smiles && row.cas_number) return;

    setLookup(row.id, 'searching');
    try {
      const result = await api.pubchem(type, query);
      if (!result.found || !result.compound) {
        setLookup(row.id, 'notfound');
        return;
      }
      const c = result.compound;
      // PubChemはSMILESをくれるが絵はくれない。ここでRDKitに描かせて svg も一緒に埋める。
      // 表示するだけならMoleculeStructureが描いてくれるが、印刷レポートはサーバ側で組むので
      // RDKitを動かせない。データにSVGを残しておかないと紙の構造式が空欄になる。
      // onChangeを2回に分けると後の呼び出しが古い rows を掴んで前の差分を消すので、先に描いておく
      const smiles = (row.smiles.trim() || c.smiles || '').trim();
      const svg = row.svg.trim() ? '' : await buildStructureSvg({ smiles });
      // 現在の行（他のセルが編集されているかもしれない）に対して差分だけ当てる
      onChange(rows.map((r) => {
        if (r.id !== row.id) return r;
        const patched: Molecule = {
          ...r,
          name: r.name.trim() || (c.name ?? ''),
          cas_number: r.cas_number.trim() || (c.cas_number ?? ''),
          smiles: r.smiles.trim() || (c.smiles ?? ''),
          molecular_weight: r.molecular_weight ?? c.molecular_weight,
          // Ketcherで描いた絵は絶対に上書きしない（人が整えた配置の方が正しい）
          svg: r.svg.trim() ? r.svg : svg,
        };
        return patched;
      }));
      setLookup(row.id, 'filled');
    } catch {
      // 照会の失敗は作業を止める理由にならない。手入力のまま進める
      setLookup(row.id, 'notfound');
    }
  };

  const renderRow = (row: Molecule, index: number, group: Molecule[]) => {
    const lookup = lookups[row.id];
    return (
      <tr key={row.id} className={row.is_reference ? 'is-reference' : undefined}>
        <td className="col-structure" data-label={t('reaction.structure')}>
          <StructureCell row={row} readOnly={readOnly} onOpen={() => setEditingId(row.id)} />
        </td>
        <td className="col-name" data-label={t('reaction.name')}>
          <TextCell
            label={t('reaction.name')}
            value={row.name}
            disabled={readOnly}
            onChange={(v) => edit(row.id, 'name', v)}
            onBlur={() => { void lookupPubChem(row, 'name'); }}
          />
          {lookup && (
            <div className={`lookup-note lookup-${lookup}`}>
              {lookup === 'searching' && t('pubchem.searching')}
              {lookup === 'filled' && t('pubchem.filled')}
              {lookup === 'notfound' && t('pubchem.notFound')}
            </div>
          )}
        </td>
        <td data-label={t('reaction.cas')}>
          <TextCell
            label={t('reaction.cas')}
            value={row.cas_number}
            placeholder="65-85-0"
            disabled={readOnly}
            onChange={(v) => edit(row.id, 'cas_number', v)}
            onBlur={() => { void lookupPubChem(row, 'cas'); }}
          />
        </td>
        <td data-label={cellLabel(t('reaction.mw'), t('reaction.mwUnit'))}>
          <NumberCell label={t('reaction.mw')} value={row.molecular_weight} disabled={readOnly}
            onChange={(v) => edit(row.id, 'molecular_weight', v)} /></td>
        <td data-label={cellLabel(t('reaction.density'), t('reaction.densityUnit'))}>
          <NumberCell label={t('reaction.density')} value={row.density} disabled={readOnly}
            onChange={(v) => edit(row.id, 'density', v)} /></td>
        <td data-label={cellLabel(t('reaction.purity'), t('reaction.purityUnit'))}>
          <NumberCell label={t('reaction.purity')} value={row.purity} disabled={readOnly}
            onChange={(v) => edit(row.id, 'purity', v)} /></td>
        <td data-label={t('reaction.equivalents')}>
          <NumberCell label={t('reaction.equivalents')} value={row.equivalents}
            disabled={readOnly || row.is_reference}
            onChange={(v) => edit(row.id, 'equivalents', v)} /></td>
        <td data-label={cellLabel(t('reaction.mass'), t('reaction.massUnit'))}>
          <NumberCell label={t('reaction.mass')} value={row.mass} disabled={readOnly}
            onChange={(v) => edit(row.id, 'mass', v)} /></td>
        <td data-label={cellLabel(t('reaction.moles'), t('reaction.molesUnit'))}>
          <NumberCell label={t('reaction.moles')} value={row.moles} disabled={readOnly}
            onChange={(v) => edit(row.id, 'moles', v)} /></td>
        <td data-label={cellLabel(t('reaction.volume'), t('reaction.volumeUnit'))}>
          <NumberCell label={t('reaction.volume')} value={row.volume} disabled={readOnly}
            onChange={(v) => edit(row.id, 'volume', v)} /></td>
        <td data-label={cellLabel(t('reaction.molarity'), t('reaction.molarityUnit'))}>
          <NumberCell label={t('reaction.molarity')} value={row.molarity} disabled={readOnly}
            onChange={(v) => edit(row.id, 'molarity', v)} /></td>
        {row.role === 'product' && (
          <td data-label={cellLabel(t('reaction.yield'), t('reaction.yieldUnit'))}>
            <NumberCell label={t('reaction.yield')} value={row.yield_percent} disabled={readOnly}
              onChange={(v) => edit(row.id, 'yield_percent', v)} /></td>
        )}
        {row.role === 'reactant' && (
          <td className="col-ref" data-label={t('reaction.reference')}>
            <input
              type="radio"
              name="reference-molecule"
              aria-label={t('reaction.referenceTitle')}
              title={t('reaction.referenceTitle')}
              checked={row.is_reference}
              disabled={readOnly}
              onChange={() => onChange(setReference(rows, row.id))}
            />
          </td>
        )}
        <td className="col-actions">
          <button type="button" className="icon-btn" title={t('reaction.moveUp')}
            disabled={readOnly || index === 0}
            onClick={() => onChange(moveRow(rows, row.id, -1))}>↑</button>
          <button type="button" className="icon-btn" title={t('reaction.moveDown')}
            disabled={readOnly || index === group.length - 1}
            onClick={() => onChange(moveRow(rows, row.id, 1))}>↓</button>
          <button type="button" className="icon-btn"
            title={row.role === 'reactant' ? t('reaction.toProduct') : t('reaction.toReactant')}
            disabled={readOnly}
            onClick={() => onChange(setRole(rows, row.id, row.role === 'reactant' ? 'product' : 'reactant'))}>
            {row.role === 'reactant' ? '→P' : '→R'}
          </button>
          <button type="button" className="icon-btn icon-danger" title={t('reaction.removeRow')}
            disabled={readOnly}
            onClick={() => { setLookup(row.id, null); onChange(removeRow(rows, row.id)); }}>×</button>
        </td>
      </tr>
    );
  };

  // 試薬マスタから原料の行を1本増やす。
  // 反応計算に効く値（分子量・密度・純度）と、見た目に効く値（名前・CAS・構造式）を引き写す。
  // molfileも持ってくるので、挿入した行の構造式はそのままKetcherで描き直せる。
  // マスタ側にSVGが無い（プリセット取込やPubChem登録の試薬）ときは、ここでRDKitに描かせて
  // 行のsvgへ入れておく。印刷レポートはサーバ側で組むのでRDKitが使えない
  const insertFromMaster = async (master: ReagentMaster) => {
    const id = crypto.randomUUID();
    const added = addRow(rows, 'reactant', id);
    const svg = master.svg.trim()
      ? master.svg
      : await buildStructureSvg({ smiles: master.smiles, molfile: master.molfile });
    onChange(added.map((r) => (r.id === id ? {
      ...r,
      name: master.name,
      cas_number: master.cas_number,
      molecular_weight: master.molecular_weight,
      density: master.density,
      // マスタに純度が入っていなければ、新規行の既定（100%）のままにする
      purity: master.purity ?? r.purity,
      smiles: master.smiles,
      molfile: master.molfile,
      svg,
    } : r)));
    setPicking(false);
  };

  const renderTable = (role: MoleculeRole, group: Molecule[]) => (
    <section className="reaction-group">
      <div className="reaction-group-head">
        <h3>{role === 'reactant' ? t('reaction.reactants') : t('reaction.products')}</h3>
        <div className="reaction-group-actions">
          {role === 'reactant' && (
            <button type="button" className="btn btn-small" disabled={readOnly}
              onClick={() => setPicking(true)}>
              {t('reagent.insert')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-small"
            disabled={readOnly}
            // 行IDはブラウザ側で採番する。サーバは知らないIDをINSERTとして扱い、ULIDを振り直す
            onClick={() => onChange(addRow(rows, role, crypto.randomUUID()))}
          >
            {role === 'reactant' ? t('reaction.addReactant') : t('reaction.addProduct')}
          </button>
        </div>
      </div>
      {group.length === 0 ? (
        <p className="empty-line">
          {role === 'reactant' ? t('reaction.noReactants') : t('reaction.noProducts')}
        </p>
      ) : (
        // reaction-scroll は「960px未満ではカードに畳むので枠と横スクロールを外す」ための札。
        // 台帳の表（.page-table）は960px帯では横スクロールのままなので、区別が要る
        <div className="table-scroll reaction-scroll">
          <table className="reaction-table">
            <thead>
              <tr>
                <th className="col-structure">{t('reaction.structure')}</th>
                <th className="col-name">{t('reaction.name')}</th>
                <th>{t('reaction.cas')}</th>
                <th>{t('reaction.mw')}<span className="unit">{t('reaction.mwUnit')}</span></th>
                <th>{t('reaction.density')}<span className="unit">{t('reaction.densityUnit')}</span></th>
                <th>{t('reaction.purity')}<span className="unit">{t('reaction.purityUnit')}</span></th>
                <th>{t('reaction.equivalents')}</th>
                <th>{t('reaction.mass')}<span className="unit">{t('reaction.massUnit')}</span></th>
                <th>{t('reaction.moles')}<span className="unit">{t('reaction.molesUnit')}</span></th>
                <th>{t('reaction.volume')}<span className="unit">{t('reaction.volumeUnit')}</span></th>
                <th>{t('reaction.molarity')}<span className="unit">{t('reaction.molarityUnit')}</span></th>
                {role === 'product' && (
                  <th>{t('reaction.yield')}<span className="unit">{t('reaction.yieldUnit')}</span></th>
                )}
                {role === 'reactant' && <th className="col-ref">{t('reaction.reference')}</th>}
                <th className="col-actions">{t('reaction.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {group.map((row, i) => renderRow(row, i, group))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const editing = editingId ? rows.find((r) => r.id === editingId) ?? null : null;

  // 構造式の保存。molfile/smiles/svg の3点を行へ書き戻す。
  // SMILESは既に手入力（またはPubChem補完）が入っていることがあるので、描いた構造を正とする。
  const saveStructure = (id: string, result: StructureResult) => {
    onChange(rows.map((r) => (
      r.id === id
        ? { ...r, molfile: result.molfile, svg: result.svg, smiles: result.smiles || r.smiles }
        : r
    )));
    setEditingId(null);
  };

  return (
    <div className="reaction">
      {renderTable('reactant', reactants)}
      {renderTable('product', products)}
      <p className="hint">{t('reaction.noReferenceHint')}</p>
      <p className="hint">{t('reaction.yieldHint')}</p>
      <p className="hint">{t('pubchem.hint')}</p>

      {picking && !readOnly && (
        <ReagentPickerModal onClose={() => setPicking(false)} onPick={(m) => { void insertFromMaster(m); }} />
      )}

      <KetcherModal
        open={editing !== null && !readOnly}
        molfile={editing?.molfile ?? ''}
        smiles={editing?.smiles ?? ''}
        rowLabel={editing?.name.trim() ?? ''}
        onClose={() => setEditingId(null)}
        onSave={(result) => { if (editing) saveStructure(editing.id, result); }}
      />
    </div>
  );
}
