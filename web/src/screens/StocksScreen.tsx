// 試薬在庫の画面。棚にある現物のボトル1本を1行として記録する。
// 試薬の指定は2通り。マスタ（試薬マスタの登録）から選ぶか、マスタに無い試薬なら名前を直接書く。
// 一覧に出る表示名・分子量はサーバがマスタをJOINして付けてくるので、画面は名前を持ち回らない。
import { useEffect, useState } from 'react';
import { api, ApiError, type ReagentMaster, type ReagentStock } from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { LedgerSearch } from '../components/LedgerBar.tsx';
import { MoleculeStructure } from '../components/MoleculeStructure.tsx';
import { useLedger } from '../hooks/useLedger.ts';
import { useApp } from '../state/AppContext.tsx';
import { t } from '../i18n.ts';

interface Form {
  id: string | null;
  // '' なら「マスタを使わない」。その場合は custom_reagent_name が要る
  reagent_master_id: string;
  custom_reagent_name: string;
  manufacturer: string;
  lot_number: string;
  received_date: string;
  is_opened: boolean;
  storage_location: string;
  remaining_amount: string;
  remaining_unit: string;
  notes: string;
}

const EMPTY: Form = {
  id: null, reagent_master_id: '', custom_reagent_name: '', manufacturer: '', lot_number: '',
  received_date: '', is_opened: false, storage_location: '', remaining_amount: '',
  remaining_unit: '', notes: '',
};

function toForm(row: ReagentStock): Form {
  return {
    id: row.id,
    reagent_master_id: row.reagent_master_id ?? '',
    custom_reagent_name: row.custom_reagent_name,
    manufacturer: row.manufacturer,
    lot_number: row.lot_number,
    received_date: row.received_date,
    is_opened: row.is_opened === 1,
    storage_location: row.storage_location,
    remaining_amount: row.remaining_amount === null ? '' : String(row.remaining_amount),
    remaining_unit: row.remaining_unit,
    notes: row.notes,
  };
}

function toNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function StocksScreen() {
  const { canEdit, reportError } = useApp();
  const ledger = useLedger<ReagentStock>(api.listStocks);
  const [masters, setMasters] = useState<ReagentMaster[]>([]);
  const [masterFilter, setMasterFilter] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ReagentStock | null>(null);

  // マスタ選択のために全件を1回だけ読む（選択肢の絞り込みは画面側で行う）
  useEffect(() => {
    let alive = true;
    api.listReagents()
      .then((list) => { if (alive) setMasters(list); })
      .catch((e) => { if (alive) reportError(e); });
    return () => { alive = false; };
  }, [reportError]);

  const openForm = (row: ReagentStock | null) => {
    setFormError(null);
    setMasterFilter('');
    setForm(row ? toForm(row) : { ...EMPTY });
  };

  const patch = (part: Partial<Form>) => setForm((current) => (current ? { ...current, ...part } : current));

  const save = async () => {
    if (!form) return;
    if (!form.reagent_master_id && !form.custom_reagent_name.trim()) {
      setFormError(t('stock.masterRequired'));
      return;
    }
    const body = {
      reagent_master_id: form.reagent_master_id,
      custom_reagent_name: form.custom_reagent_name.trim(),
      manufacturer: form.manufacturer.trim(),
      lot_number: form.lot_number.trim(),
      received_date: form.received_date,
      is_opened: form.is_opened,
      storage_location: form.storage_location.trim(),
      remaining_amount: toNumber(form.remaining_amount),
      remaining_unit: form.remaining_unit.trim(),
      notes: form.notes,
    };
    try {
      if (form.id) await api.patchStock(form.id, body);
      else await api.createStock(body);
      setForm(null);
      await ledger.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setFormError(t('stock.masterRequired'));
      else { reportError(e); setForm(null); }
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api.deleteStock(deleting.id);
      await ledger.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setDeleting(null);
    }
  };

  const rows = ledger.rows;
  const keyword = masterFilter.trim().toLowerCase();
  const options = keyword
    ? masters.filter((m) => `${m.name} ${m.cas_number}`.toLowerCase().includes(keyword))
    : masters;

  return (
    <main className="layout single">
      <section className="panel">
        <div className="panel-head">
          <h2>{t('stock.heading')}</h2>
          {canEdit && (
            <button type="button" className="btn btn-primary btn-small" onClick={() => openForm(null)}>
              {t('stock.new')}
            </button>
          )}
        </div>
        <p className="hint">{t('stock.lead')}</p>
        <LedgerSearch ledger={ledger} placeholder={t('stock.searchPlaceholder')} />
      </section>

      {form && (
        <section className="panel">
          <div className="panel-head">
            <h2>{form.id ? t('stock.editTitle') : t('stock.createTitle')}</h2>
          </div>

          <div className="field">
            <span className="field-label">{t('stock.fromMaster')}</span>
            {/* 検索付きセレクト。上の欄で候補を絞り、下の選択肢から1つ選ぶ */}
            <input
              className="master-filter"
              type="search"
              value={masterFilter}
              placeholder={t('stock.masterPlaceholder')}
              aria-label={t('stock.masterPlaceholder')}
              onChange={(e) => setMasterFilter(e.target.value)}
            />
            <select
              className="master-select"
              value={form.reagent_master_id}
              aria-label={t('stock.fromMaster')}
              onChange={(e) => patch({ reagent_master_id: e.target.value })}
            >
              <option value="">{t('stock.masterNone')}</option>
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.cas_number ? `（${m.cas_number}）` : ''}
                </option>
              ))}
            </select>
          </div>

          <label className="field">
            <span>{t('stock.customName')}</span>
            <input value={form.custom_reagent_name} placeholder={t('stock.customPlaceholder')}
              onChange={(e) => patch({ custom_reagent_name: e.target.value })} />
          </label>

          <div className="form-grid">
            <label className="field">
              <span>{t('stock.manufacturer')}</span>
              <input value={form.manufacturer} placeholder={t('stock.manufacturerPlaceholder')}
                onChange={(e) => patch({ manufacturer: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('stock.lot')}</span>
              <input value={form.lot_number}
                onChange={(e) => patch({ lot_number: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('stock.receivedDate')}</span>
              <input type="date" value={form.received_date}
                onChange={(e) => patch({ received_date: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('stock.storage')}</span>
              <input value={form.storage_location} placeholder={t('stock.storagePlaceholder')}
                onChange={(e) => patch({ storage_location: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('stock.remaining')}</span>
              <input inputMode="decimal" value={form.remaining_amount}
                onChange={(e) => patch({ remaining_amount: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('stock.remainingUnit')}</span>
              <input value={form.remaining_unit} placeholder={t('stock.remainingUnitPlaceholder')}
                onChange={(e) => patch({ remaining_unit: e.target.value })} />
            </label>
          </div>

          <label className="field field-check">
            <input type="checkbox" checked={form.is_opened}
              onChange={(e) => patch({ is_opened: e.target.checked })} />
            <span>{t('stock.isOpened')}</span>
          </label>

          <label className="field">
            <span>{t('ledger.notes')}</span>
            <textarea className="notes-input" rows={3} value={form.notes}
              placeholder={t('ledger.notesPlaceholder')}
              onChange={(e) => patch({ notes: e.target.value })} />
          </label>

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
          <p className="empty-line">{ledger.query ? t('ledger.noMatch', { query: ledger.query }) : t('stock.empty')}</p>
        ) : (
          <>
            <p className="hint">{t('ledger.count', { count: rows.length })}</p>
            {/* 列が多いので、狭い画面では表だけ横スクロールさせる */}
            <div className="table-scroll">
              <table className="page-table">
                <thead>
                  <tr>
                    <th className="col-structure">{t('reaction.structure')}</th>
                    <th>{t('stock.name')}</th>
                    <th>{t('stock.manufacturer')}</th>
                    <th>{t('stock.lot')}</th>
                    <th className="col-status">{t('stock.isOpened')}</th>
                    <th>{t('stock.storage')}</th>
                    <th className="col-num">{t('stock.remaining')}</th>
                    <th className="col-date">{t('stock.receivedDate')}</th>
                    <th className="col-actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      {/* マスタに紐づいた在庫だけ絵が出る。カスタム名だけの行はSMILESが無いので「—」 */}
                      <td className="col-structure">
                        <MoleculeStructure smiles={row.smiles ?? ''} alt={row.display_name} />
                      </td>
                      <td className="col-main">
                        <span className="ledger-name">{row.display_name}</span>
                        {row.master_name === null && row.reagent_master_id === null && (
                          <span className="ledger-sub">{t('stock.customName')}</span>
                        )}
                      </td>
                      <td data-label={t('stock.manufacturer')}>{row.manufacturer || '—'}</td>
                      <td data-label={t('stock.lot')}>{row.lot_number || '—'}</td>
                      <td className="col-status" data-label={t('common.status')}>
                        <span className={`badge badge-${row.is_opened ? 'draft' : 'closed'}`}>
                          {row.is_opened ? t('stock.opened') : t('stock.unopened')}
                        </span>
                      </td>
                      <td data-label={t('stock.storage')}>{row.storage_location || '—'}</td>
                      <td className="col-num" data-label={t('stock.remaining')}>
                        {row.remaining_amount === null ? '—' : `${row.remaining_amount} ${row.remaining_unit}`.trim()}
                      </td>
                      <td className="col-date" data-label={t('stock.receivedDate')}>{row.received_date || '—'}</td>
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
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <Modal
        open={deleting !== null}
        title={t('stock.deleteTitle')}
        onClose={() => setDeleting(null)}
        onSubmit={() => { void remove(); }}
        submitDanger
        submitLabel={t('common.delete')}
      >
        {deleting && <p>{t('stock.deleteConfirm', { name: deleting.display_name })}</p>}
      </Modal>
    </main>
  );
}
