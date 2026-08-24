// 死活確認。ログイン不要で叩ける唯一のAPI（監視・デプロイ後の疎通確認用）。
// 秘密になり得る情報は返さない。

// package.json の version と同じ値にする（test/health.test.mjs が一致を検査する）
export const VERSION = '1.3.0';

// demo は「この設置がデモモードかどうか」だけ。ログイン画面が未ログインのまま知る手段が
// これしかないので、health に乗せている（秘密ではない・既定は false）
export function health(env) {
  return {
    status: 200,
    data: { ok: true, version: VERSION, demo: env?.DEMO_MODE === '1' },
  };
}
