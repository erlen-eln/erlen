// アプリ全体で共有する状態はこの1本だけ。
//   ・ログイン状態（/api/me の結果）
//   ・画面下に出る一言通知（保存失敗など）
// 画面遷移や編集中の内容は各画面の useState に閉じている。状態管理ライブラリは入れない。
import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode,
} from 'react';
import { api, ApiError, type Me } from '../api.ts';
import { t } from '../i18n.ts';

type SessionStatus = 'loading' | 'in' | 'out';

interface State {
  status: SessionStatus;
  me: Me | null;
  notice: string | null;
}

type Action =
  | { type: 'signedIn'; me: Me }
  | { type: 'signedOut' }
  | { type: 'notice'; message: string | null };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'signedIn': return { ...state, status: 'in', me: action.me };
    case 'signedOut': return { ...state, status: 'out', me: null };
    case 'notice': return { ...state, notice: action.message };
  }
}

interface AppContextValue extends State {
  // 権限。画面はこの2つだけを見る（ロール名の比較を各画面に散らかさない）
  //   canEdit … 書き込みUIを出してよいか（viewerはfalse。自動保存も止める）
  //   isOwner … メンバー管理を出してよいか
  //   isDemo  … 公開デモで入った閲覧者か（案内文とバッジの出し分けだけに使う）
  canEdit: boolean;
  isOwner: boolean;
  isDemo: boolean;
  // API呼び出しの失敗を1か所で処理する。401ならログイン画面へ戻し、それ以外は通知を出す
  reportError: (error: unknown) => void;
  notify: (message: string | null) => void;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { status: 'loading', me: null, notice: null });

  useEffect(() => {
    let alive = true;
    api.me()
      .then((me) => { if (alive) dispatch({ type: 'signedIn', me }); })
      .catch(() => { if (alive) dispatch({ type: 'signedOut' }); });
    return () => { alive = false; };
  }, []);

  const notify = useCallback((message: string | null) => {
    dispatch({ type: 'notice', message });
  }, []);

  const reportError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      dispatch({ type: 'signedOut' });
      return;
    }
    if (error instanceof ApiError && error.status === 0) {
      dispatch({ type: 'notice', message: t('common.networkError') });
      return;
    }
    console.error('erlen api error', error);
    dispatch({ type: 'notice', message: t('common.error') });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      dispatch({ type: 'signedOut' });
    }
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      ...state,
      // 画面側の判定は「viewerでなければ書ける」。サーバも同じ規則で403を返す
      canEdit: state.me !== null && state.me.role !== 'viewer',
      isOwner: state.me?.role === 'owner',
      isDemo: state.me?.demo === true,
      reportError,
      notify,
      signOut,
    }),
    [state, reportError, notify, signOut]
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp は AppProvider の内側でだけ使えます');
  return value;
}
