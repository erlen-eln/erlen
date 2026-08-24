// 台帳3種（試薬マスタ・試薬在庫・機器）に共通する「一覧と絞り込み」の状態。
// 3画面とも「読み込む → ?q= で絞る → 書き換えたら読み直す」しかしないので、ここ1本にまとめる。
// 絞り込みは打つたびに叩かず、Enter（またはボタン）で確定してからサーバへ問い合わせる。
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';

export interface Ledger<T> {
  // 読み込み中はnull（画面は「読み込み中…」を出す）
  rows: T[] | null;
  // 実行済みの絞り込み語（空文字なら全件）
  query: string;
  input: string;
  setInput: (value: string) => void;
  submit: () => void;
  clear: () => void;
  reload: () => Promise<void>;
}

// load には api.listReagents などをそのまま渡す（api は固定のオブジェクトなので識別子が変わらない）
export function useLedger<T>(load: (q: string) => Promise<T[]>): Ledger<T> {
  const { reportError } = useApp();
  const [rows, setRows] = useState<T[] | null>(null);
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');

  const run = useCallback(async (q: string) => {
    setRows(null);
    try {
      setRows(await load(q));
    } catch (e) {
      reportError(e);
      setRows([]);
    }
  }, [load, reportError]);

  useEffect(() => { void run(query); }, [run, query]);

  return {
    rows,
    query,
    input,
    setInput,
    submit: () => setQuery(input.trim()),
    clear: () => { setInput(''); setQuery(''); },
    reload: () => run(query),
  };
}
