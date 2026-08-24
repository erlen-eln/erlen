// 機器の画面。研究室の装置の一覧（測定条件を書くときの控え）。
// 列が多いので、一覧は主要な列だけを出し、詳細（容量・温度範囲・圧力範囲・備考）は
// 名前の下に小さく添える。編集は画面内のパネル（他の台帳と同じ作り）。
import { useState } from 'react';
import { api, ApiError, type Equipment } from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { LedgerSearch, PresetLoader } from '../components/LedgerBar.tsx';
import { useLedger } from '../hooks/useLedger.ts';
import { useApp } from '../state/AppContext.tsx';
import { t } from '../i18n.ts';

type Form = Omit<Equipment, 'id' | 'created_at' | 'updated_at'> & { id: string | null };

const EMPTY: Form = {
  id: null, name: '', category: '', capacity: '', temperature_range: '', pressure_range: '',
  manufacturer: '', model_number: '', management_number: '', notes: '',
};

function toForm(row: Equipment): Form {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    capacity: row.capacity,
    temperature_range: row.temperature_range,
    pressure_range: row.pressure_range,
    manufacturer: row.manufacturer,
    model_number: row.model_number,
    management_number: row.management_number,
    notes: row.notes,
  };
}

export function EquipmentsScreen() {
  const { canEdit, reportError } = useApp();
  const ledger = useLedger<Equipment>(api.listEquipments);
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Equipment | null>(null);

  const openForm = (row: Equipment | null) => {
    setFormError(null);
    setForm(row ? toForm(row) : { ...EMPTY });
  };

  const patch = (part: Partial<Form>) => setForm((current) => (current ? { ...current, ...part } : current));

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) { setFormError(t('ledger.nameRequired')); return; }
    const { id, ...body } = form;
    try {
      if (id) await api.patchEquipment(id, body);
      else await api.createEquipment(body);
      setForm(null);
      await ledger.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setFormError(t('ledger.nameRequired'));
      else { reportError(e); setForm(null); }
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api.deleteEquipment(deleting.id);
      await ledger.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setDeleting(null);
    }
  };

  const rows = ledger.rows;

  // 入力欄は「見出し・現在値・プレースホルダ」だけが違うので表で持つ
  const fields: { key: keyof Omit<Form, 'id' | 'notes'>; label: string; placeholder?: string }[] = [
    { key: 'name', label: t('equipment.name'), placeholder: t('equipment.namePlaceholder') },
    { key: 'category', label: t('equipment.category'), placeholder: t('equipment.categoryPlaceholder') },
    { key: 'capacity', label: t('equipment.capacity'), placeholder: t('equipment.capacityPlaceholder') },
    {
      key: 'temperature_range',
      label: t('equipment.temperatureRange'),
      placeholder: t('equipment.temperaturePlaceholder'),
    },
    {
      key: 'pressure_range',
      label: t('equipment.pressureRange'),
      placeholder: t('equipment.pressurePlaceholder'),
    },
    { key: 'manufacturer', label: t('equipment.manufacturer'), placeholder: 'BUCHI' },
    { key: 'model_number', label: t('equipment.modelNumber'), placeholder: 'R-300' },
    {
      key: 'management_number',
      label: t('equipment.managementNumber'),
      placeholder: t('equipment.managementPlaceholder'),
    },
  ];

  return (
    <main className="layout single">
      <section className="panel">
        <div className="panel-head">
          <h2>{t('equipment.heading')}</h2>
          <div className="panel-head-actions">
            {canEdit && (
              <PresetLoader
                file="equipments.json"
                send={api.bulkCreateEquipments}
                onDone={() => { void ledger.reload(); }}
              />
            )}
            {canEdit && (
              <button type="button" className="btn btn-primary btn-small" onClick={() => openForm(null)}>
                {t('equipment.new')}
              </button>
            )}
          </div>
        </div>
        <p className="hint">{t('equipment.lead')}</p>
        <LedgerSearch ledger={ledger} placeholder={t('equipment.searchPlaceholder')} />
      </section>

      {form && (
        <section className="panel">
          <div className="panel-head">
            <h2>{form.id ? t('equipment.editTitle') : t('equipment.createTitle')}</h2>
          </div>
          <div className="form-grid">
            {fields.map((f, i) => (
              <label className="field" key={f.key}>
                <span>
                  {f.label}
                  {f.key === 'name' && <em className="req">{t('common.required')}</em>}
                </span>
                <input
                  autoFocus={i === 0}
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => patch({ [f.key]: e.target.value } as Partial<Form>)}
                />
              </label>
            ))}
          </div>
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
          <p className="empty-line">
            {ledger.query ? t('ledger.noMatch', { query: ledger.query }) : t('equipment.empty')}
          </p>
        ) : (
          <>
            <p className="hint">{t('ledger.count', { count: rows.length })}</p>
            {/* 列が多いので、狭い画面では表だけ横スクロールさせる */}
            <div className="table-scroll">
              <table className="page-table">
                <thead>
                  <tr>
                    <th>{t('equipment.name')}</th>
                    <th>{t('equipment.category')}</th>
                    <th>{t('equipment.manufacturer')}</th>
                    <th>{t('equipment.modelNumber')}</th>
                    <th>{t('equipment.managementNumber')}</th>
                    <th className="col-actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    // 一覧に列を増やしすぎないよう、範囲まわりは名前の下へ1行でまとめる
                    const detail = [row.capacity, row.temperature_range, row.pressure_range]
                      .filter(Boolean).join(' ／ ');
                    return (
                      <tr key={row.id}>
                        <td className="col-main">
                          <span className="ledger-name">{row.name}</span>
                          {detail && <span className="ledger-sub" title={detail}>{detail}</span>}
                          {row.notes && <span className="ledger-sub" title={row.notes}>{row.notes}</span>}
                        </td>
                        <td data-label={t('equipment.category')}>{row.category || '—'}</td>
                        <td data-label={t('equipment.manufacturer')}>{row.manufacturer || '—'}</td>
                        <td data-label={t('equipment.modelNumber')}>{row.model_number || '—'}</td>
                        <td data-label={t('equipment.managementNumber')}>{row.management_number || '—'}</td>
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
        title={t('equipment.deleteTitle')}
        onClose={() => setDeleting(null)}
        onSubmit={() => { void remove(); }}
        submitDanger
        submitLabel={t('common.delete')}
      >
        {deleting && <p>{t('equipment.deleteConfirm', { name: deleting.name })}</p>}
      </Modal>
    </main>
  );
}
