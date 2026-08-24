// ログイン画面。/api/me が401のときだけ出る。
// 認証はサーバ側（Google OAuth）に任せているので、ここは /auth/login へ送り出すだけ。
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { t } from '../i18n.ts';

// 購入・詳細の入口。デモ機からだけ出す（自分のノートには出ない）
const SITE_URL = 'https://erlen.jp';

export function LoginScreen() {
  // /auth/callback は ?login=denied / ?login=error を付けて /app へ戻してくる
  const reason = new URLSearchParams(window.location.search).get('login');
  // ここが公開デモ機かどうかは /api/health でしか分からない（未ログインなので /api/me は401）。
  // 取得に失敗したら「デモではない」＝案内を出さない側へ倒す
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let alive = true;
    api.health()
      .then((h) => { if (alive) setDemo(h.demo === true); })
      .catch(() => { /* 素の画面のまま出す */ });
    return () => { alive = false; };
  }, []);

  return (
    <main className="login">
      <div className="login-card">
        <h1>{t('login.heading')}</h1>
        <p className="login-sub">{t('login.subtitle')}</p>
        {demo ? <p className="demo-lead">{t('login.demoLead')}</p> : <p>{t('login.lead')}</p>}
        {reason === 'denied' && <p className="alert">{t('login.denied')}</p>}
        {reason === 'error' && <p className="alert">{t('login.failed')}</p>}
        {/* ログイン後の戻り先はサーバ側の許可リスト（auth.mjsのALLOWED_NEXT_PATHS）で /app に固定される */}
        <a className="btn btn-primary btn-block" href="/auth/login">
          {t('login.button')}
        </a>
        {demo && (
          <p className="demo-buy">
            <a href={SITE_URL} target="_blank" rel="noreferrer noopener">{t('login.demoBuy')}</a>
          </p>
        )}
      </div>
    </main>
  );
}
