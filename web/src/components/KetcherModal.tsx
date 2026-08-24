// 構造式エディタ（Ketcher）のモーダル。
//
// Ketcherは22MBあるので、アプリのバンドルには一切混ぜない。
// public/ketcher/editor.html を iframe で開き、postMessage で会話する。
//   1. 子から READY が来たら、いま行に入っている molfile を SET_MOLECULE で送る
//   2. 子が読み込みを終えて LOADED を返したら「保存」を押せるようにする
//   3. 「保存」で GET_RESULT を送り、RESULT（molfile / smiles / svg）を受け取る
//   4. 受け取った3点を行へ書き戻す（あとは反応テーブルの自動保存に乗る）
// 同一オリジン（同じWorkerが配る）なので、送信先も受信元も自分のオリジンに限定する。
//
// LOADEDを待つ理由: Ketcherは起動直後だと構造を解釈するエンジンが温まっておらず、
// setMolecule が「白紙のまま成功」することがある。そこで保存を押せないようにして、
// 保存済みの構造式を空で上書きする事故を止めている（詳細は editor.html の冒頭）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { smilesToMolblock } from './rdkit.ts';
import { t } from '../i18n.ts';

// 行に書き戻す3点。空文字は「構造式を消した」を表す
export interface StructureResult {
  molfile: string;
  smiles: string;
  svg: string;
}

interface Props {
  open: boolean;
  // 開いたときにKetcherへ読み込ませる既存の構造（無ければ空文字＝白紙から描く）
  molfile: string;
  // molfileが無い行のための控え。Ketcherはmolfileしか読めないので、
  // RDKitで座標を起こしてから渡す（PubChem補完・プリセット・マスタ挿入の行はこちらしか持たない）
  smiles: string;
  // 見出しに出す試薬名（どの行を編集しているのか分かるように）
  rowLabel: string;
  onClose: () => void;
  onSave: (result: StructureResult) => void;
}

// 実体は public/ketcher/editor.html。
// Workers Assets は既定で .html を落としたURL（/ketcher/editor）へ307で飛ばすので、
// 最初からそちらを指す（毎回リダイレクトを1往復させないため）。
// このURLでも相対パス（./static/js/...）は /ketcher/static/js/... に解決される。
const EDITOR_SRC = '/ketcher/editor';

export function KetcherModal({ open, molfile, smiles, rowLabel, onClose, onSave }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  // 既存の構造の読み込みが済んだか。これが立つまで保存は押せない
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 閉じているあいだは iframe ごと外す。Ketcherの22MBを毎回読ませないよう、
  // 「開いたことがあるか」ではなく open で出し入れする単純な作りにしてある。
  // （ブラウザのキャッシュが効くので2回目以降の再表示は速い）
  useEffect(() => {
    if (open) return;
    setReady(false);
    setLoaded(false);
    setBusy(false);
    setError(null);
  }, [open]);

  const post = useCallback((message: unknown) => {
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    if (!open) return;
    // 閉じたあとに非同期の変換が返ってきても、消えたiframeへ投げないようにする
    let alive = true;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; message?: string } & Partial<StructureResult>;
      if (!data || typeof data.type !== 'string') return;

      if (data.type === 'READY') {
        setReady(true);
        setError(null);
        if (molfile.trim()) {
          post({ type: 'SET_MOLECULE', molfile });
          return;
        }
        // molfileが無い行。SMILESがあればRDKitで座標を起こして渡す。
        // 起こせなければ白紙で開く（描き直してもらう）
        void smilesToMolblock(smiles).then((built) => {
          if (alive) post({ type: 'SET_MOLECULE', molfile: built });
        });
        return;
      }
      if (data.type === 'LOADED') {
        setLoaded(true);
        return;
      }
      if (data.type === 'RESULT') {
        setBusy(false);
        onSave({
          molfile: data.molfile ?? '',
          smiles: data.smiles ?? '',
          svg: data.svg ?? '',
        });
        return;
      }
      if (data.type === 'ERROR') {
        setBusy(false);
        setError(data.message ?? t('ketcher.error'));
      }
    };
    window.addEventListener('message', onMessage);
    return () => { alive = false; window.removeEventListener('message', onMessage); };
  }, [open, molfile, smiles, post, onSave]);

  // Escで閉じる（<dialog>は使わない。iframeの中でキー入力を奪い合わないようにするため）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ketcher-backdrop" role="dialog" aria-modal="true" aria-label={t('ketcher.title')}>
      <div className="ketcher-panel">
        <div className="ketcher-head">
          <h2>{t('ketcher.title')}{rowLabel && <span className="ketcher-row">{rowLabel}</span>}</h2>
          <div className="ketcher-head-right">
            {!loaded && <span className="ketcher-status">{t('ketcher.loading')}</span>}
            <button type="button" className="btn btn-small" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={!ready || !loaded || busy}
              onClick={() => { setBusy(true); setError(null); post({ type: 'GET_RESULT' }); }}
            >
              {busy ? t('ketcher.saving') : t('common.save')}
            </button>
          </div>
        </div>
        {error && <p className="alert ketcher-alert">{error}</p>}
        <iframe
          ref={frame}
          className="ketcher-frame"
          src={EDITOR_SRC}
          title={t('ketcher.title')}
        />
        <p className="hint ketcher-hint">{t('ketcher.hint')}</p>
      </div>
    </div>
  );
}
