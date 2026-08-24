// 試薬マスタの画面。研究室で使う試薬の「定義」を貯めておく場所。
// ここに登録した試薬は、実験ページの反応テーブルで「マスタから挿入」から呼び出せる。
// 入力の手間を減らす道具を2つ載せている。
//   ・CAS番号／名前を入れて次の欄へ移ると PubChem から分子量などを補完（反応テーブルと同じ仕組み）
//   ・構造式は Ketcher（KetcherModal）で描いて svg/molfile/smiles を保存
// 編集フォームはモーダルではなく画面内のパネルにしてある。
// <dialog> の中からKetcher（固定配置のオーバーレイ）を開くと、ダイアログの下に潜ってしまうため。
import { useState } from 'react';
import { api, ApiError, type ReagentMaster } from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { KetcherModal } from '../components/KetcherModal.tsx';
import { LedgerSearch, PresetLoader } from '../components/LedgerBar.tsx';
import { MoleculeStructure } from '../components/MoleculeStructure.tsx';
import { buildStructureSvg } from '../components/rdkit.ts';
import { useLedger } from '../hooks/useLedger.ts';
import { useApp } from '../state/AppContext.tsx';
import { t } from '../i18n.ts';

// フォームは全部の欄を文字列で持つ（打ちかけの "1." が消えないように）。
// 保存する直前だけ数値へ直す。
interface Form {
  id: string | null;
  name: string;
  cas_number: string;
  molecular_weight: string;
  purity: string;
  density: string;
  smiles: string;
  molfile: string;
  svg: string;
  notes: string;
}

const EMPTY: Form = {
  id: null, name: '', cas_number: '', molecular_weight: '', purity: '', density: '',
  smiles: '', molfile: '', svg: '', notes: '',
};

const numText = (value: number | null): string => (value === null ? '' : String(value));

function toForm(row: ReagentMaster): Form {
  return {
    id: row.id,
    name: row.name,
    cas_number: row.cas_number,
    molecular_weight: numText(row.molecular_weight),
    purity: numText(row.purity),
    density: numText(row.density),
    smiles: row.smiles,
    molfile: row.molfile,
    svg: row.svg,
    notes: row.notes,
  };
}

// 空欄はnull（未記入）。数字にならない入力もnullへ倒す
function toNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function ReagentsScreen() {
  const { canEdit, reportError, notify } = useApp();
  const ledger = useLedger<ReagentMaster>(api.listReagents);
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ReagentMaster | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [lookup, setLookup] = useState<'searching' | 'filled' | 'notfound' | null>(null);
  // 構造式の一括生成の進み具合（nullなら走っていない）
  const [filling, setFilling] = useState<{ done: number; total: number } | null>(null);

  const openForm = (row: ReagentMaster | null) => {
    setFormError(null);
    setLookup(null);
    setForm(row ? toForm(row) : { ...EMPTY });
  };

  const patch = (part: Partial<Form>) => setForm((current) => (current ? { ...current, ...part } : current));

  // 名前・CAS欄からフォーカスが外れたらPubChemへ照会し、空いている欄だけ埋める。
  // 既に入っている値は上書きしない（実測値を消さないため）
  const lookupPubChem = async (type: 'cas' | 'name') => {
    if (!form) return;
    const query = (type === 'cas' ? form.cas_number : form.name).trim();
    if (!query) return;
    if (form.molecular_weight && form.smiles && form.cas_number) return;
    setLookup('searching');
    try {
      const result = await api.pubchem(type, query);
      if (!result.found || !result.compound) { setLookup('notfound'); return; }
      const c = result.compound;
      setForm((current) => (current ? {
        ...current,
        name: current.name.trim() || (c.name ?? ''),
        cas_number: current.cas_number.trim() || (c.cas_number ?? ''),
        smiles: current.smiles.trim() || (c.smiles ?? ''),
        molecular_weight: current.molecular_weight.trim() || numText(c.molecular_weight),
      } : current));
      setLookup('filled');
    } catch {
      // 照会の失敗は作業を止める理由にならない。手入力のまま進める
      setLookup('notfound');
    }
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) { setFormError(t('ledger.nameRequired')); return; }
    // SMILESだけ入っていて絵が無い試薬は、保存する前にRDKitで描いておく。
    // 一覧はMoleculeStructureがその場で描くので画面上は困らないが、
    // 印刷レポートはサーバ側で組む＝RDKitが動かないので、データにSVGが要る。
    // Ketcherで描いた絵があるときは触らない
    const svg = form.svg.trim()
      ? form.svg
      : await buildStructureSvg({ smiles: form.smiles, molfile: form.molfile });
    const body = {
      name: form.name.trim(),
      cas_number: form.cas_number.trim(),
      molecular_weight: toNumber(form.molecular_weight),
      purity: toNumber(form.purity),
      density: toNumber(form.density),
      smiles: form.smiles.trim(),
      molfile: form.molfile,
      svg,
      notes: form.notes,
    };
    try {
      if (form.id) await api.patchReagent(form.id, body);
      else await api.createReagent(body);
      setForm(null);
      await ledger.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setFormError(t('ledger.nameRequired'));
      else { reportError(e); setForm(null); }
    }
  };

  // 「構造式を一括生成」。SMILES（かmolfile）はあるのにSVGが無い試薬をまとめて埋める。
  // プリセット取込（POST /api/reagents/bulk）はSVGを持たない状態で入るので、その後始末がここ。
  // 一覧の表示はMoleculeStructureがその場で描くので困らないが、
  // 印刷レポートはサーバ側で組む＝RDKitが動かないため、データにSVGを残しておく必要がある。
  // 1件ずつPATCHする（D1へ一度に投げると重い・途中で失敗しても済んだぶんは残る）。
  const fillMissingSvg = async () => {
    const targets = (ledger.rows ?? []).filter(
      (row) => !row.svg.trim() && (row.smiles.trim() || row.molfile.trim())
    );
    if (targets.length === 0) { notify(t('reagent.fillSvgNone')); return; }
    setFilling({ done: 0, total: targets.length });
    let saved = 0;
    try {
      for (const row of targets) {
        const svg = await buildStructureSvg({ smiles: row.smiles, molfile: row.molfile });
        // 描けなかったもの（解釈できないSMILES）は飛ばす。空のSVGで上書きしない
        if (svg) {
          await api.patchReagent(row.id, { svg });
          saved += 1;
        }
        setFilling((current) => (current ? { ...current, done: current.done + 1 } : current));
      }
      notify(t('reagent.fillSvgDone', { count: saved }));
      await ledger.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setFilling(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api.deleteReagent(deleting.id);
      await ledger.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setDeleting(null);
    }
  };

  const rows = ledger.rows;
  // 「SMILESはあるのに画像が無い」試薬の件数。0なら一括生成のボタンは出さない
  const missingSvgCount = (rows ?? []).filter(
    (row) => !row.svg.trim() && (row.smiles.trim() || row.molfile.trim())
  ).length;

  return (
    <main className="layout single">
      <section className="panel">
        <div className="panel-head">
          <h2>{t('reagent.heading')}</h2>
          <div className="panel-head-actions">
            {canEdit && (
              <PresetLoader
                file="solvents.json"
                send={api.bulkCreateReagents}
                onDone={() => { void ledger.reload(); }}
              />
            )}
            {canEdit && missingSvgCount > 0 && (
              <button
                type="button"
                className="btn btn-small"
                title={t('reagent.fillSvgHint')}
                disabled={filling !== null}
                onClick={() => { void fillMissingSvg(); }}
              >
                {filling
                  ? t('reagent.fillSvgBusy', { done: filling.done, total: filling.total })
                  : `${t('reagent.fillSvg')}（${missingSvgCount}）`}
              </button>
            )}
            {canEdit && (
              <button type="button" className="btn btn-primary btn-small" onClick={() => openForm(null)}>
                {t('reagent.new')}
              </button>
            )}
          </div>
        </div>
        <p className="hint">{t('reagent.lead')}</p>
        <LedgerSearch ledger={ledger} placeholder={t('reagent.searchPlaceholder')} />
      </section>

      {form && (
        <section className="panel">
          <div className="panel-head">
            <h2>{form.id ? t('reagent.editTitle') : t('reagent.createTitle')}</h2>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>{t('reaction.name')}<em className="req">{t('common.required')}</em></span>
              <input autoFocus value={form.name} placeholder={t('reagent.namePlaceholder')}
                onChange={(e) => patch({ name: e.target.value })}
                onBlur={() => { void lookupPubChem('name'); }} />
            </label>
            <label className="field">
              <span>{t('reaction.cas')}</span>
              <input value={form.cas_number} placeholder="108-88-3"
                onChange={(e) => patch({ cas_number: e.target.value })}
                onBlur={() => { void lookupPubChem('cas'); }} />
            </label>
            <label className="field">
              <span>{t('reaction.mw')}（{t('reaction.mwUnit')}）</span>
              <input inputMode="decimal" value={form.molecular_weight}
                onChange={(e) => patch({ molecular_weight: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('reaction.purity')}（{t('reaction.purityUnit')}）</span>
              <input inputMode="decimal" value={form.purity}
                onChange={(e) => patch({ purity: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('reaction.density')}（{t('reaction.densityUnit')}）</span>
              <input inputMode="decimal" value={form.density}
                onChange={(e) => patch({ density: e.target.value })} />
            </label>
            <label className="field">
              <span>SMILES</span>
              <input value={form.smiles} onChange={(e) => patch({ smiles: e.target.value })} />
            </label>
          </div>

          <div className="form-structure">
            <span className="field-label">{t('reaction.structure')}</span>
            {/* 保存済みSVGが最優先。無ければ打ち込んだ（またはPubChemが入れた）SMILESをRDKitが描く */}
            <MoleculeStructure
              size="large"
              svg={form.svg}
              molfile={form.molfile}
              smiles={form.smiles}
              alt={form.name}
              title={t('ketcher.edit')}
              fallback={t('ketcher.draw')}
              onClick={() => setDrawing(true)}
            />
          </div>

          <label className="field">
            <span>{t('ledger.notes')}</span>
            <textarea className="notes-input" value={form.notes} rows={3}
              placeholder={t('ledger.notesPlaceholder')}
              onChange={(e) => patch({ notes: e.target.value })} />
          </label>

          {lookup && (
            <p className={`lookup-note lookup-${lookup}`}>
              {lookup === 'searching' && t('pubchem.searching')}
              {lookup === 'filled' && t('pubchem.filled')}
              {lookup === 'notfound' && t('pubchem.notFound')}
            </p>
          )}
          <p className="hint">{t('pubchem.hint')}</p>
          {formError && <p className="alert">{formError}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setForm(null)}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={() => { void save(); }}>
              {t('common.save')}
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        {rows === null ? (
          <p className="empty-line">{t('common.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="empty-line">{ledger.query ? t('ledger.noMatch', { query: ledger.query }) : t('reagent.empty')}</p>
        ) : (
          <>
            <p className="hint">{t('ledger.count', { count: rows.length })}</p>
            {/* 列が多いので、狭い画面では表だけ横スクロールさせる。
                スマホ幅（640px以下）ではさらに1行＝1カードへ畳む（見出しは data-label） */}
            <div className="table-scroll">
              <table className="page-table">
                <thead>
                  <tr>
                    <th className="col-structure">{t('reaction.structure')}</th>
                    <th>{t('reaction.name')}</th>
                    <th>{t('reaction.cas')}</th>
                    <th className="col-num">{t('reaction.mw')}</th>
                    <th className="col-num">{t('reaction.purity')}</th>
                    <th className="col-num">{t('reaction.density')}</th>
                    <th className="col-actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    return (
                      <tr key={row.id}>
                        <td className="col-structure">
                          {/* 溶媒プリセットのようにSVGを持たない行も、SMILESがあればRDKitが描く */}
                          <MoleculeStructure
                            svg={row.svg}
                            molfile={row.molfile}
                            smiles={row.smiles}
                            alt={row.name}
                          />
                        </td>
                        <td className="col-main">
                          <span className="ledger-name">{row.name}</span>
                          {row.notes && <span className="ledger-sub" title={row.notes}>{row.notes}</span>}
                        </td>
                        <td data-label={t('reaction.cas')}>{row.cas_number || '—'}</td>
                        <td className="col-num" data-label={t('reaction.mw')}>
                          {numText(row.molecular_weight) || '—'}
                        </td>
                        <td className="col-num" data-label={t('reaction.purity')}>
                          {numText(row.purity) || '—'}
                        </td>
                        <td className="col-num" data-label={t('reaction.density')}>
                          {numText(row.density) || '—'}
                        </td>
                        <td className="col-actions">
                          {canEdit && (
                            <>
                              <button type="button" className="link-btn" onClick={() => openForm(row)}>
                                {t('ledger.edit')}
                              </button>
                              <button type="button" className="link-btn link-danger" onClick={() => setDeleting(row)}>
                                {t('common.delete')}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <Modal
        open={deleting !== null}
        title={t('reagent.deleteTitle')}
        onClose={() => setDeleting(null)}
        onSubmit={() => { void remove(); }}
        submitDanger
        submitLabel={t('common.delete')}
      >
        {deleting && <p>{t('reagent.deleteConfirm', { name: deleting.name })}</p>}
      </Modal>

      <KetcherModal
        open={drawing && form !== null}
        molfile={form?.molfile ?? ''}
        smiles={form?.smiles ?? ''}
        rowLabel={form?.name.trim() ?? ''}
        onClose={() => setDrawing(false)}
        onSave={(result) => {
          patch({ molfile: result.molfile, svg: result.svg, smiles: result.smiles || (form?.smiles ?? '') });
          setDrawing(false);
        }}
      />
    </main>
  );
}
