// wrangler CLI呼び出しの共通土台。npm経由でなくwranglerのJS本体をnodeで直接起動する。
// 理由(Windows実障害): npmコマンドのspawnは実体がnpm.cmdのためENOENTで落ちる。
// shell経由にするとSQL等の引数がcmd.exeのクオート解釈で壊れるため、
// シェルを挟まず引数がそのまま渡る直接起動が全OS共通の正解。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export function runWrangler(args, opts = {}) {
  if (!existsSync(WRANGLER_BIN)) {
    throw new Error('node_modules/wrangler がありません。先に npm ci を実行してください');
  }
  return spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}
