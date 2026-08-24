// 画面の起点。ここは結線だけ。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AppProvider } from './state/AppContext.tsx';
import { LOCALE_STORAGE_KEY, setLocale, type Locale } from './i18n.ts';
import './app.css';

const TITLES: Record<Locale, string> = {
  ja: 'Erlen — 電子実験ノート',
  en: 'Erlen — Electronic Lab Notebook',
};

// ロケールの決定。render前に確定させる（コンポーネントは常に確定済みのロケールで描画される）。
//   1. localStorageに保存済みならそれ
//   2. 無ければブラウザの言語（ja始まりならja、それ以外はen）
function initialLocale(): Locale {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved === 'ja' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

const locale = initialLocale();
setLocale(locale);
document.documentElement.lang = locale;
document.title = TITLES[locale];

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません（index.htmlを確認してください）');

createRoot(root).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
);
