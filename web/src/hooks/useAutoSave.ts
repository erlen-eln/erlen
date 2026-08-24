// 自動保存。入力が止まって1.5秒後に保存する。
//
// 「値が変わったら保存」ではなく「revision（編集のたびに+1する数）が進んだら保存」にしてある。
// サーバから読み込んだ直後や、保存結果を state に書き戻したときに保存が再発火するのを防ぐため。
// 使う側は、利用者が触った瞬間だけ revision を進めること。
import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export const AUTOSAVE_DELAY_MS = 1500;

export interface AutoSave {
  state: SaveState;
  // 画面を離れるとき・「再試行」を押されたときなど、待たずに今すぐ保存する
  flush: () => Promise<void>;
  dirty: boolean;
}

export function useAutoSave(
  revision: number,
  save: () => Promise<void>,
  options: { enabled?: boolean; delayMs?: number } = {}
): AutoSave {
  const { enabled = true, delayMs = AUTOSAVE_DELAY_MS } = options;
  const [state, setState] = useState<SaveState>('idle');

  // 保存関数と現在のrevisionは毎レンダー作り直されるので、実行時に最新を掴めるようrefへ逃がす
  const saveRef = useRef(save);
  saveRef.current = save;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

  const savedRevision = useRef(revision); // 保存済みの地点
  const inFlight = useRef(false);

  const run = useCallback(async () => {
    const target = revisionRef.current;
    if (inFlight.current || target === savedRevision.current) return;
    inFlight.current = true;
    setState('saving');
    try {
      await saveRef.current();
      savedRevision.current = target;
      setState('saved');
    } catch {
      // 失敗しても編集内容は画面に残る。次の編集か「再試行」で挑戦し直す
      // （ここで自動リトライを回すと、サーバが落ちている間ずっと叩き続けることになる）
      setState('error');
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (revision === savedRevision.current) return;
    const timer = setTimeout(() => { void run(); }, delayMs);
    return () => clearTimeout(timer);
  }, [revision, enabled, delayMs, run]);

  const flush = useCallback(async () => {
    if (enabled) await run();
  }, [enabled, run]);

  return { state, flush, dirty: revision !== savedRevision.current };
}

// 2系統（本文とテーブル）の保存状態を1つの表示にまとめる。困っている方を優先して出す
export function mergeSaveState(...states: SaveState[]): SaveState {
  if (states.includes('error')) return 'error';
  if (states.includes('saving')) return 'saving';
  if (states.includes('saved')) return 'saved';
  return 'idle';
}
