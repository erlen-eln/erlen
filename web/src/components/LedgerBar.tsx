// 台帳3画面（試薬マスタ・試薬在庫・機器）で共通に使う小物2つ。
//   LedgerSearch … 絞り込みの入力欄（Enterかボタンで確定してサーバへ）
//   PresetLoader … 同梱プリセット（public/presets/*.json）の取り込みボタンと確認モーダル
import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Modal } from './Modal.tsx';
import { useApp } from '../state/AppContext.tsx';
import type { Ledger } from '../hooks/useLedger.ts';
import { t } from '../i18n.ts';

export function LedgerSearch<T>({ ledger, placeholder }: { ledger: Ledger<T>; placeholder: string }) {
  return (
    <form
      className="search-form"
      onSubmit={(e) => { e.preventDefault(); ledger.submit(); }}
    >
      <input
        type="search"
        className="search-input"
        value={ledger.input}
        aria-label={t('ledger.search')}
        placeholder={placeholder}
        onChange={(e) => {
          ledger.setInput(e.target.value);
          // 入力欄を空にしたら全件へ戻す（×ボタンを押したときの自然な挙動）
          if (!e.target.value.trim()) ledger.clear();
        }}
      />
      <button type="submit" className="btn btn-small">{t('ledger.searchRun')}</button>
      {ledger.query && (
        <button type="button" className="link-btn" onClick={ledger.clear}>{t('ledger.clear')}</button>
      )}
    </form>
  );
}

interface PresetLoaderProps<T> {
  // public/presets/ の下のファイル名（例 'solvents.json'）
  file: string;
  // 取り込みの実行。api.bulkCreateReagents / api.bulkCreateEquipments を渡す
  send: (items: T[]) => Promise<{ created: number }>;
  onDone: () => void;
}

// プリセットの読み込みボタン。押すとJSONを取りに行き、件数を見せてから確認する。
// 呼び出し側で canEdit を見て、閲覧専用のときはそもそも描かない。
export function PresetLoader<T>({ file, send, onDone }: PresetLoaderProps<T>) {
  const { reportError, notify } = useApp();
  const [preset, setPreset] = useState<{ name: string; items: T[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const loaded = await api.loadPreset<T>(file);
      setPreset({ name: loaded.meta.name, items: loaded.items });
    } catch (e) {
      // プリセットが無い・壊れているのは作業を止める理由にならない。手入力で進められる
      if (e instanceof ApiError) notify(t('ledger.presetFailed'));
      else reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!preset) return;
    setBusy(true);
    try {
      const result = await send(preset.items);
      notify(t('ledger.presetDone', { count: result.created }));
      setPreset(null);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'too_many_items') notify(t('ledger.presetTooMany'));
      else reportError(e);
      setPreset(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => { void open(); }}>
        {busy && !preset ? t('ledger.presetLoading') : t('ledger.loadPreset')}
      </button>
      <Modal
        open={preset !== null}
        title={t('ledger.presetTitle')}
        onClose={() => setPreset(null)}
        onSubmit={() => { void submit(); }}
        submitLabel={t('common.ok')}
      >
        {preset && (
          <>
            <p>{t('ledger.presetConfirm', { name: preset.name, count: preset.items.length })}</p>
            <p className="hint">{t('ledger.presetNote')}</p>
          </>
        )}
      </Modal>
    </>
  );
}
