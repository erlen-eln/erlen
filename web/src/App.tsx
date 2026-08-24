// 画面の切り替え。ルーターは入れない。
// 画面はノート一覧・ページ編集・台帳3種（試薬／在庫／機器）・メンバー管理だけなので、
// useStateで持つ方が読みやすい（URLは /app/ の1本のまま）。
import { useState } from 'react';
import { EquipmentsScreen } from './screens/EquipmentsScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { MembersScreen } from './screens/MembersScreen.tsx';
import { NotebookListScreen } from './screens/NotebookListScreen.tsx';
import { PageEditorScreen } from './screens/PageEditorScreen.tsx';
import { ProjectsScreen } from './screens/ProjectsScreen.tsx';
import { ReagentsScreen } from './screens/ReagentsScreen.tsx';
import { StocksScreen } from './screens/StocksScreen.tsx';
import { useApp } from './state/AppContext.tsx';
import { getLocale, LOCALE_STORAGE_KEY, t, type Locale, type MessageKey } from './i18n.ts';

type Tab = 'notebooks' | 'reagents' | 'stocks' | 'equipments';
type OwnerMenu = 'projects' | 'members';
type View = { name: Tab } | { name: 'page'; pageId: string } | { name: OwnerMenu };

// オーナーだけに出す入口。editor/viewerには入口ごと出さない（サーバも403で断る）
const OWNER_MENUS: { key: OwnerMenu; label: MessageKey }[] = [
  { key: 'projects', label: 'project.menu' },
  { key: 'members', label: 'members.menu' },
];

// タブの並び。ここに1行足せばナビゲーションに出る
const TABS: { key: Tab; label: MessageKey }[] = [
  { key: 'notebooks', label: 'nav.notebooks' },
  { key: 'reagents', label: 'nav.reagents' },
  { key: 'stocks', label: 'nav.stocks' },
  { key: 'equipments', label: 'nav.equipments' },
];

// 購入・詳細の入口。デモ機のヘッダにだけ小さく出す（自分のノートには出ない）
const SITE_URL = 'https://erlen.jp';

// ヘッダに出す権限の表示名
function roleLabel(role: string): string {
  if (role === 'owner') return t('role.owner');
  if (role === 'viewer') return t('role.viewer');
  return t('role.editor');
}

// 表示言語の切り替え（JA | EN）。切替はlocalStorageに保存してリロードするだけ
// （main.tsxが起動時にそこを読んで setLocale する。i18n側の状態を実行中に書き換える設計にはしない）
function switchLocale(locale: Locale): void {
  if (locale === getLocale()) return;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  location.reload();
}

function LocaleSwitch() {
  const current = getLocale();
  return (
    <span className="locale-switch" aria-label={t('common.langSwitch')}>
      <button
        type="button"
        className={`locale-switch-btn${current === 'ja' ? ' locale-switch-current' : ''}`}
        aria-current={current === 'ja' ? 'true' : undefined}
        onClick={() => switchLocale('ja')}
      >
        {t('common.langJa')}
      </button>
      <span className="locale-switch-sep" aria-hidden="true">|</span>
      <button
        type="button"
        className={`locale-switch-btn${current === 'en' ? ' locale-switch-current' : ''}`}
        aria-current={current === 'en' ? 'true' : undefined}
        onClick={() => switchLocale('en')}
      >
        {t('common.langEn')}
      </button>
    </span>
  );
}

export function App() {
  const { status, me, canEdit, isOwner, isDemo, notice, notify, signOut } = useApp();
  const [view, setView] = useState<View>({ name: 'notebooks' });

  if (status === 'loading') {
    return <main className="layout single"><p className="empty-line">{t('common.loading')}</p></main>;
  }
  if (status === 'out') return <LoginScreen />;

  // ページ編集中は、どのタブから来たかに関わらず「ノート」を選択状態にする
  const current: string = view.name === 'page' ? 'notebooks' : view.name;

  // スマホ幅ではメールアドレスを丸1文字に畳む（横幅をタブに譲る）。
  // 出し分けはCSS（.who / .who-avatar）に任せて、ここは両方を描いておく
  const email = me?.email ?? '';
  const initial = email.trim().charAt(0).toUpperCase() || '?';

  return (
    <>
      <header className="app-header">
        <button type="button" className="app-title" onClick={() => setView({ name: 'notebooks' })}>
          <span className="app-title-name">{t('app.title')}</span>
          {/* 「何のアプリか」の説明。狭い画面ではタブに幅を譲って隠れる（CSS側） */}
          <span className="app-title-sub">{t('app.subtitle')}</span>
        </button>
        <nav className="app-nav" aria-label={t('nav.label')}>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`nav-btn${current === tab.key ? ' nav-btn-current' : ''}`}
              aria-current={current === tab.key ? 'page' : undefined}
              onClick={() => setView({ name: tab.key })}
            >
              {t(tab.label)}
            </button>
          ))}
          {/* プロジェクトとメンバー管理はオーナーだけ */}
          {isOwner && OWNER_MENUS.map((menu) => (
            <button
              key={menu.key}
              type="button"
              className={`nav-btn${current === menu.key ? ' nav-btn-current' : ''}`}
              aria-current={current === menu.key ? 'page' : undefined}
              onClick={() => setView({ name: menu.key })}
            >
              {t(menu.label)}
            </button>
          ))}
        </nav>
        <div className="app-header-right">
          <LocaleSwitch />
          <span className="who" title={email}>{email}</span>
          {/* 読み上げには頭文字ではなくメールアドレス全文を渡す（見えているのは1文字だけなので） */}
          <span className="who-avatar" role="img" aria-label={email} title={email}>{initial}</span>
          <span className={`role-tag${canEdit ? '' : ' role-tag-viewer'}`}>
            {isDemo ? t('role.demoBadge') : canEdit ? roleLabel(me?.role ?? '') : t('role.viewerBadge')}
          </span>
          {isDemo && (
            <a className="demo-buy-link" href={SITE_URL} target="_blank" rel="noreferrer noopener">
              {t('login.demoBuy')}
            </a>
          )}
          <button type="button" className="link-btn" onClick={() => { void signOut(); }}>
            {t('login.logout')}
          </button>
        </div>
      </header>

      {view.name === 'members' ? (
        <MembersScreen onBack={() => setView({ name: 'notebooks' })} />
      ) : view.name === 'projects' ? (
        <ProjectsScreen onBack={() => setView({ name: 'notebooks' })} />
      ) : view.name === 'page' ? (
        <PageEditorScreen pageId={view.pageId} onBack={() => setView({ name: 'notebooks' })} />
      ) : view.name === 'reagents' ? (
        <ReagentsScreen />
      ) : view.name === 'stocks' ? (
        <StocksScreen />
      ) : view.name === 'equipments' ? (
        <EquipmentsScreen />
      ) : (
        <NotebookListScreen onOpenPage={(pageId) => setView({ name: 'page', pageId })} />
      )}

      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button type="button" className="link-btn" onClick={() => notify(null)}>
            {t('common.close')}
          </button>
        </div>
      )}
    </>
  );
}
