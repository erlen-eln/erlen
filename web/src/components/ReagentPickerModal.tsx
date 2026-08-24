// 反応テーブルの「マスタから挿入」で開く、試薬マスタの検索モーダル。
// 選ぶと、その試薬の値（名前・CAS・分子量・密度・純度・構造式）を持った原料の行が1本増える。
// 絞り込みはサーバの ?q=（LIKE検索）に任せる。
// 検索欄は <form> にしない。このモーダル自体が <form> なので、入れ子にすると壊れるため
// （Enterは onKeyDown で拾って絞り込みに使う）。
import { api, type ReagentMaster } from '../api.ts';
import { Modal } from './Modal.tsx';
import { MoleculeStructure } from './MoleculeStructure.tsx';
import { useLedger } from '../hooks/useLedger.ts';
import { t } from '../i18n.ts';

interface Props {
  onClose: () => void;
  onPick: (reagent: ReagentMaster) => void;
}

// 開いているあいだだけマウントする（マウント＝一覧の読み込み）
export function ReagentPickerModal({ onClose, onPick }: Props) {
  const ledger = useLedger<ReagentMaster>(api.listReagents);
  const rows = ledger.rows;

  return (
    <Modal open wide title={t('reagent.insertTitle')} onClose={onClose}>
      <div className="search-form">
        <input
          autoFocus
          type="search"
          className="search-input"
          value={ledger.input}
          aria-label={t('ledger.search')}
          placeholder={t('reagent.searchPlaceholder')}
          onChange={(e) => {
            ledger.setInput(e.target.value);
            if (!e.target.value.trim()) ledger.clear();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault(); // モーダルを閉じずに絞り込む
            ledger.submit();
          }}
        />
        <button type="button" className="btn btn-small" onClick={ledger.submit}>
          {t('ledger.searchRun')}
        </button>
      </div>

      {rows === null ? (
        <p className="empty-line">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="empty-line">
          {ledger.query ? t('ledger.noMatch', { query: ledger.query }) : t('reagent.insertEmpty')}
        </p>
      ) : (
        <ul className="picker-list">
          {rows.map((row) => {
            return (
              <li key={row.id}>
                <button type="button" className="picker-item" onClick={() => onPick(row)}>
                  {/* 保存済みSVGが無くてもSMILESがあればRDKitが描く（溶媒プリセットはこの経路） */}
                  <MoleculeStructure
                    className="picker-structure"
                    svg={row.svg}
                    molfile={row.molfile}
                    smiles={row.smiles}
                    alt={row.name}
                  />
                  <span className="picker-body">
                    <span className="ledger-name">{row.name}</span>
                    <span className="ledger-sub">
                      {[
                        row.cas_number,
                        row.molecular_weight === null ? '' : `${t('reaction.mw')} ${row.molecular_weight}`,
                        row.density === null ? '' : `${t('reaction.density')} ${row.density}`,
                      ].filter(Boolean).join(' ／ ') || '—'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint">{t('reagent.insertHint')}</p>
    </Modal>
  );
}
