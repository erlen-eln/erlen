// GitHub公開まわりの設定ファイルの検品。
//
// 【なぜ機械で見るのか】
// ワークフローYAMLの間違いは、**タグを打った瞬間まで分からない**（手元では何も動かない）。
// actionlint のような外部ツールをこのリポジトリに足す気は無い（依存ゼロの方針）ので、
// YAMLの構文と「このリポジトリの運用で外せない中身」だけを自前で検査する。
//
// 検査するもの:
//   .github/workflows/ci.yml           … push / PR でテストと型検査が走ること
//   .github/workflows/release.yml      … v* タグで配布zipがReleaseに添付されること
//   .github/ISSUE_TEMPLATE/*.yml       … Issueフォームとして成立していること
//   .github/PULL_REQUEST_TEMPLATE.md   … 設計の掟がチェック項目として残っていること
//   CONTRIBUTING.md / SECURITY.md / ROADMAP.md / docs/MAINTAINING.md
//   → そして、これら全部に**メールアドレスが1つも書かれていない**こと（連絡はGitHubへ寄せる）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------- YAMLの部分実装
//
// GitHub Actions と Issue フォームが使う範囲だけを読む小さなパーサ。
// 目的は「値を取り出すこと」よりも「壊れたYAMLで落ちること」。だから本物のYAMLより**厳しく**、
// 実際に事故になりやすい書き方（タブ・引用符なしの `key: value` 内のコロン）を拒否する。
export function parseYaml(text, label = 'YAML') {
  if (text.includes('\t')) throw new Error(`${label}: タブが含まれています（YAMLはタブを許さない）`);
  const rawLines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const lines = [];
  rawLines.forEach((raw, i) => {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    lines.push({ n: i + 1, indent: raw.length - raw.trimStart().length, text: raw.trim() });
  });
  if (!lines.length) return {};

  let pos = 0;
  const KEY = /^([^:#]+):(?:\s+([\s\S]*))?$/;
  const KEYLIKE = /^[^:#\s][^:#]*:(\s|$)/;

  function scalar(raw, n) {
    const s = raw.trim();
    if (/^'[\s\S]*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^"[\s\S]*"$/.test(s)) return s.slice(1, -1);
    if (/^\[[\s\S]*\]$/.test(s)) {
      return s.slice(1, -1).split(',').map((x) => x.trim()).filter((x) => x !== '')
        .map((x) => scalar(x, n));
    }
    // 引用符なしの値にコロン＋空白やコメント開始が入ると、本物のYAMLは別の意味に取る
    if (s.includes(': ')) {
      throw new Error(`${label}: ${n}行目の値にコロンがあります。引用符で囲ってください → ${s}`);
    }
    if (/\s#/.test(s)) {
      throw new Error(`${label}: ${n}行目の値に行末コメントがあります。引用符で囲ってください → ${s}`);
    }
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    return s;
  }

  // `|` / `>` のブロックスカラー。中身はコメントも空行もそのまま本文なので rawLines から拾う
  function blockScalar(keyN, keyIndent, style) {
    const body = [];
    let i = keyN; // keyN は1始まりなので、次の行の0始まり添字がそのまま keyN
    let lastN = keyN;
    while (i < rawLines.length) {
      const raw = rawLines[i];
      if (raw.trim() === '') { body.push(''); i += 1; continue; }
      const indent = raw.length - raw.trimStart().length;
      if (indent <= keyIndent) break;
      body.push(raw.trim());
      lastN = i + 1;
      i += 1;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    while (pos < lines.length && lines[pos].n <= lastN) pos += 1;
    return style === '>' ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n');
  }

  function parseBlock(indent) {
    if (pos >= lines.length || lines[pos].indent !== indent) return null;
    return (lines[pos].text === '-' || lines[pos].text.startsWith('- '))
      ? parseSeq(indent) : parseMap(indent);
  }

  function parseMap(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent
      && !(lines[pos].text === '-' || lines[pos].text.startsWith('- '))) {
      const line = lines[pos];
      const m = KEY.exec(line.text);
      if (!m) throw new Error(`${label}: ${line.n}行目を「key: value」として読めません → ${line.text}`);
      const key = m[1].trim();
      if (key in out) throw new Error(`${label}: ${line.n}行目でキー "${key}" が重複しています`);
      const rest = (m[2] ?? '').trim();
      pos += 1;
      if (/^[|>][-+]?$/.test(rest)) {
        out[key] = blockScalar(line.n, indent, rest[0]);
      } else if (rest === '') {
        out[key] = (pos < lines.length && lines[pos].indent > indent)
          ? parseBlock(lines[pos].indent) : null;
      } else {
        out[key] = scalar(rest, line.n);
      }
    }
    return out;
  }

  function parseSeq(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent
      && (lines[pos].text === '-' || lines[pos].text.startsWith('- '))) {
      const line = lines[pos];
      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      if (rest === '') {
        pos += 1;
        out.push(pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null);
        continue;
      }
      // 「- key: value」は、その行を indent+2 のマップの1行目として読み直す
      lines[pos] = { n: line.n, indent: indent + 2, text: rest };
      if (KEYLIKE.test(rest)) {
        out.push(parseMap(indent + 2));
      } else {
        pos += 1;
        out.push(scalar(rest, line.n));
      }
    }
    return out;
  }

  const doc = parseBlock(lines[0].indent);
  if (pos < lines.length) {
    throw new Error(`${label}: ${lines[pos].n}行目でインデントが揃っていません → ${lines[pos].text}`);
  }
  return doc;
}

// -------------------------------------------------- パーサ自身の検査（偽緑よけ）
//
// 「何を渡しても通るパーサ」なら、上のYAML検査は全部意味を失う。壊れた入力で落ちることを先に示す。

test('YAMLパーサ: 入れ子・シーケンス・ブロックスカラーを読める', () => {
  const doc = parseYaml([
    'name: sample',
    'on:',
    '  push:',
    '    branches:',
    '      - main',
    '  workflow_dispatch:',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: run it',
    '        run: |',
    '          echo one',
    '          echo two',
    '        with:',
    '          flag: true',
    '',
  ].join('\n'));
  assert.equal(doc.name, 'sample');
  assert.deepEqual(doc.on.push.branches, ['main']);
  assert.equal(doc.on.workflow_dispatch, null);
  assert.equal(doc.jobs.build.steps.length, 2);
  assert.equal(doc.jobs.build.steps[0].uses, 'actions/checkout@v4');
  assert.equal(doc.jobs.build.steps[1].run, 'echo one\necho two');
  assert.equal(doc.jobs.build.steps[1].with.flag, true);
});

test('YAMLパーサ: 壊れた書き方をちゃんと落とす', () => {
  const broken = {
    タブ: 'jobs:\n\tbuild: x\n',
    インデント崩れ: 'jobs:\n  build:\n     runs-on: x\n   steps: y\n',
    'コロンの引用漏れ': 'name: title: subtitle\n',
    'キーになっていない行': 'name value\n',
    キー重複: 'name: a\nname: b\n',
  };
  for (const [why, text] of Object.entries(broken)) {
    assert.throws(() => parseYaml(text, 'broken'), undefined, `${why}: 落ちるべき入力が通った`);
  }
});

// ------------------------------------------------------------------ 対象ファイル

const WORKFLOW_DIR = '.github/workflows';
const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';

const YAML_FILES = [
  ...readdirSync(path.join(ROOT, WORKFLOW_DIR)).map((f) => `${WORKFLOW_DIR}/${f}`),
  ...readdirSync(path.join(ROOT, TEMPLATE_DIR)).map((f) => `${TEMPLATE_DIR}/${f}`),
];

const ci = parseYaml(read(`${WORKFLOW_DIR}/ci.yml`), 'ci.yml');
const release = parseYaml(read(`${WORKFLOW_DIR}/release.yml`), 'release.yml');

// ステップの `run` / `uses` を1本の文字列にして「その中身が居るか」を見るための道具
const stepsOf = (job) => job.steps ?? [];
const runsOf = (job) => stepsOf(job).map((s) => s.run ?? '').join('\n');
const usesOf = (job) => stepsOf(job).map((s) => s.uses ?? '').filter(Boolean);

// ---------------------------------------------------------------------- 共通の形

test('.github のYAMLは全部パースできる（構文ゲート）', () => {
  assert.ok(YAML_FILES.length >= 5, `対象が少なすぎる: ${YAML_FILES.length}件`);
  for (const rel of YAML_FILES) {
    assert.match(rel, /\.ya?ml$/, `${rel}: .yml 以外が混ざっている`);
    assert.doesNotThrow(() => parseYaml(read(rel), rel));
  }
});

test('.github のYAMLに末尾の空白が無く、改行で終わっている', () => {
  for (const rel of YAML_FILES) {
    const text = read(rel);
    assert.ok(text.endsWith('\n'), `${rel}: 最終行が改行で終わっていない`);
    const bad = text.split('\n').map((l, i) => (/[ \t]$/.test(l) ? i + 1 : 0)).filter(Boolean);
    assert.deepEqual(bad, [], `${rel}: 行末に空白がある行 → ${bad.join(', ')}`);
  }
});

// -------------------------------------------------------------------- ci.yml

test('ci.yml: push と pull_request の両方で走る', () => {
  assert.equal(ci.name, 'CI');
  assert.ok(ci.on, 'on: が無い');
  assert.deepEqual(ci.on.push.branches, ['main'], 'push対象のブランチがmainでない');
  assert.ok('pull_request' in ci.on, 'pull_request で走らない');
});

test('ci.yml: 権限は読み取りだけ', () => {
  assert.deepEqual(ci.permissions, { contents: 'read' }, 'CIに書き込み権限を与えている');
});

test('ci.yml: テストと型検査の2ジョブがある', () => {
  const jobs = Object.keys(ci.jobs ?? {});
  assert.deepEqual(jobs.sort(), ['test', 'typecheck-web']);
  for (const name of jobs) {
    assert.equal(ci.jobs[name]['runs-on'], 'ubuntu-latest', `${name}: runs-onが無い`);
    assert.ok(stepsOf(ci.jobs[name]).length >= 4, `${name}: stepsが足りない`);
    for (const step of stepsOf(ci.jobs[name])) {
      assert.ok(step.uses || step.run, `${name}: uses も run も無いステップがある`);
    }
  }
});

test('ci.yml: 本体ジョブは npm ci → npm test（Node 22・キャッシュあり）', () => {
  const job = ci.jobs.test;
  const uses = usesOf(job);
  assert.ok(uses.includes('actions/checkout@v4'), 'checkout@v4 が無い');
  assert.ok(uses.includes('actions/setup-node@v4'), 'setup-node@v4 が無い');
  const setup = stepsOf(job).find((s) => s.uses === 'actions/setup-node@v4');
  assert.equal(String(setup.with['node-version']), '22', 'Nodeが22でない（engines は >=22.5）');
  assert.equal(setup.with.cache, 'npm', 'npmキャッシュが無い');
  const runs = runsOf(job);
  assert.match(runs, /npm ci/, 'npm ci が無い（npm install で代用していないか）');
  assert.match(runs, /npm test/, 'npm test が無い');
});

test('ci.yml: 画面ジョブは web/ の依存を入れてから型検査する', () => {
  const job = ci.jobs['typecheck-web'];
  const setup = stepsOf(job).find((s) => s.uses === 'actions/setup-node@v4');
  assert.equal(String(setup.with['node-version']), '22');
  assert.equal(setup.with['cache-dependency-path'], 'web/package-lock.json',
    'web/ のlockfileをキャッシュ対象にしていない');
  const runs = runsOf(job);
  assert.match(runs, /npm --prefix web ci/, 'web/ の npm ci が無い');
  assert.match(runs, /npm run typecheck:web/, '型検査が走っていない');
});

// --------------------------------------------------------------- release.yml

test('release.yml: v* のタグを押したときだけ走る', () => {
  assert.ok(release.on?.push?.tags, 'タグのトリガーが無い');
  assert.deepEqual(release.on.push.tags, ['v*']);
  assert.ok(!('pull_request' in (release.on ?? {})), 'PRでリリースを走らせている');
});

test('release.yml: contents: write を明示している', () => {
  assert.deepEqual(release.permissions, { contents: 'write' },
    'Releaseを作るには contents: write の明示が要る');
});

test('release.yml: テスト → zip → Release添付の順で並んでいる', () => {
  const job = release.jobs.release;
  assert.equal(job['runs-on'], 'ubuntu-latest');
  const runs = runsOf(job);
  assert.match(runs, /npm ci/, 'npm ci が無い');
  assert.match(runs, /npm test/, 'npm test が無い');
  assert.match(runs, /scripts\/package\.mjs/, '配布zipを作っていない');
  assert.match(runs, /scripts\/release-notes\.mjs/, 'リリースノートを組み立てていない');

  const order = stepsOf(job).map((s) => `${s.uses ?? ''} ${s.run ?? ''}`);
  const at = (needle) => order.findIndex((s) => s.includes(needle));
  assert.ok(at('release-notes.mjs') < at('package.mjs'),
    '版の検算（release-notes.mjs）はzipを作る前に走らせること');
  assert.ok(at('npm test') < at('package.mjs'), 'テストはzipより先');
  assert.ok(at('package.mjs') < at('action-gh-release'), 'zipを作る前にReleaseを作っている');
});

test('release.yml: 作ったzipをReleaseへ添付している', () => {
  const step = stepsOf(release.jobs.release).find((s) => (s.uses ?? '').includes('action-gh-release'));
  assert.ok(step, 'Releaseを作るステップが無い');
  assert.match(step.uses, /@v\d+$/, 'Actionの版が固定されていない');
  assert.match(step.with.files, /dist-zip\/erlen-.*\.zip/, 'zipの添付先が違う');
  assert.equal(step.with.body_path, 'release-notes.md', '本文を生成物から取っていない');
});

test('release.yml が呼ぶ検算スクリプトが実在する', () => {
  assert.ok(existsSync(path.join(ROOT, 'scripts/release-notes.mjs')));
});

// ------------------------------------------------------------ Issueテンプレート

test('Issueテンプレートは日本語での投稿を歓迎している', () => {
  for (const name of ['bug_report.yml', 'feature_request.yml']) {
    const rel = `${TEMPLATE_DIR}/${name}`;
    const form = parseYaml(read(rel), rel);
    assert.ok(form.name && form.description, `${name}: name / description が無い`);
    assert.ok(Array.isArray(form.body) && form.body.length >= 3, `${name}: bodyが薄い`);
    for (const field of form.body) {
      assert.ok(field.type, `${name}: type の無いフィールドがある`);
      assert.ok(field.attributes, `${name}: attributes の無いフィールドがある`);
      if (field.type !== 'markdown') {
        assert.ok(field.id, `${name}: ${field.type} に id が無い`);
        assert.ok(field.attributes.label, `${name}: ${field.id} に label が無い`);
      }
    }
    const text = read(rel);
    assert.match(text, /Japanese is welcome/, `${name}: 日本語歓迎の英文が無い`);
    assert.match(text, /日本語/, `${name}: 日本語歓迎の和文が無い`);
  }
});

test('不具合テンプレートは秘密と研究データを貼らせない', () => {
  const text = read(`${TEMPLATE_DIR}/bug_report.yml`);
  assert.match(text, /GOOGLE_CLIENT_SECRET/, '秘密の値を貼らない注意が無い');
  assert.match(text, /database_id/, 'database_idを貼らない注意が無い');
  assert.match(text, /Security Advisor/i, '脆弱性を別窓口へ案内していない');
});

test('config.yml: 白紙Issueを許し、サイト・デモ・脆弱性窓口へ案内する', () => {
  const rel = `${TEMPLATE_DIR}/config.yml`;
  const config = parseYaml(read(rel), rel);
  assert.equal(config.blank_issues_enabled, true, '白紙のIssueを閉じている');
  const urls = config.contact_links.map((l) => l.url);
  assert.ok(urls.includes('https://erlen.jp'), '公式サイトへの案内が無い');
  assert.ok(urls.includes('https://demo.erlen.jp/app'), '公開デモへの案内が無い');
  assert.ok(urls.some((u) => u.includes('/security/advisories/new')), '脆弱性の窓口が無い');
  for (const link of config.contact_links) {
    assert.ok(link.name && link.about, 'contact_link に name / about が無い');
  }
});

// -------------------------------------------------- 窓口の振り分け（2026-08-26の決定）
//
// 用途で分ける: 日本語の質問・相談はDiscordのコミュニティ、不具合・要望はIssue（日本語可）、
// 脆弱性はSecurity Advisory。英語はIssueが主な窓口（Discordは日本語で運営しているため）。
// 決めただけでは戻るので、README と config.yml の両方をここで機械検査する。

const DISCORD_INVITE = 'https://discord.gg/VzKjRGtzm';

test('config.yml: 日本語の質問先としてDiscordの入口がある', () => {
  const rel = `${TEMPLATE_DIR}/config.yml`;
  const config = parseYaml(read(rel), rel);
  const discord = config.contact_links.filter((l) => String(l.url).includes('discord.gg'));
  assert.equal(discord.length, 1, 'Discordの入口が1本でない');
  assert.equal(discord[0].url, DISCORD_INVITE, '招待URLが正本と違う（旧リンクを撒いていないか）');
  assert.match(discord[0].about, /実験データ/, '実データを貼らない注意が入口に無い');
});

test('READMEが窓口を用途で振り分けている（日英とも）', () => {
  const readme = read('README.md');
  assert.ok(readme.includes(DISCORD_INVITE), 'READMEにDiscordの招待URLが無い');
  assert.match(readme, /https:\/\/github\.com\/erlen-eln\/erlen\/issues/, 'READMEにIssuesへの導線が無い');
  assert.match(readme, /実験データそのもの/, '日本語側に実データを貼らない注意が無い');
  assert.match(readme, /do not paste real experimental data/, '英語側に実データを貼らない注意が無い');
  // 英語の窓口はIssuesに固定する（英語話者をDiscordへ誘導しない）
  assert.match(readme, /In English, GitHub Issues is the place/, '英語の主窓口がIssuesだと明示されていない');
});

// ---------------------------------------------------------------- PRテンプレート

test('PRテンプレートに設計の掟がチェック項目として載っている', () => {
  const text = read('.github/PULL_REQUEST_TEMPLATE.md');
  const boxes = text.split('\n').filter((l) => l.trim().startsWith('- [ ]'));
  assert.ok(boxes.length >= 6, `チェック項目が少なすぎる: ${boxes.length}件`);
  assert.match(text, /npm test/, 'npm test の確認が無い');
  assert.match(text, /Response/, 'api層がResponseを作らない掟が無い');
  assert.match(text, /migrations/, 'migrationsが追記のみである掟が無い');
  assert.match(text, /build:web/, '画面を直したときのビルドの確認が無い');
  assert.match(text, /tenant_id/, 'tenant_idの掟が無い');
});

// -------------------------------------------------------------- 公開まわりの文書

test('公開まわりの文書が揃っている', () => {
  const required = [
    'CONTRIBUTING.md',
    'SECURITY.md',
    'ROADMAP.md',
    'docs/MAINTAINING.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
  ];
  const missing = required.filter((f) => !existsSync(path.join(ROOT, f)));
  assert.deepEqual(missing, [], `欠けている: ${missing.join(', ')}`);
});

test('CONTRIBUTING.md に環境の作り方・テスト・掟・PRの出し方がある', () => {
  const text = read('CONTRIBUTING.md');
  assert.match(text, /Japanese is welcome|日本語/, '日本語で書いてよいと明記していない');
  assert.match(text, /npm ci/, '環境の作り方が無い');
  assert.match(text, /node --test/, 'テストの走らせ方が無い');
  assert.match(text, /Response/, 'api層の掟が無い');
  assert.match(text, /tenant_id/, 'tenant_idの掟が無い');
  assert.match(text, /追記のみ/, 'migrationsの掟が無い');
  assert.match(text, /public\/app/, 'ビルド成果物をコミットする話が無い');
  assert.match(text, /Apache License 2\.0/, '貢献の扱い（Apache-2.0 §5）が無い');
});

test('SECURITY.md は非公開の窓口へ寄せ、SLAを約束していない', () => {
  const text = read('SECURITY.md');
  assert.match(text, /security\/advisories\/new/, '非公開の報告窓口が無い');
  assert.match(text, /公開Issueにしないでください/, '公開Issueを止めていない');
  assert.match(text, /SLA/, '応答時間を約束しない旨が無い');
  assert.ok(!/\d+\s*(時間|営業日)以内に(必ず|かならず)/.test(text), '応答時間を約束している');
});

test('ROADMAP.md は約束ではないと断っている', () => {
  const text = read('ROADMAP.md');
  assert.match(text, /約束ではありません|not a commitment/, '約束でない旨が無い');
  assert.match(text, /TipTap/, '検討中の項目（リッチテキスト）が無い');
  assert.match(text, /1\.3/, '安定版の基点が書かれていない');
  // 日付を書かない約束。「2026-09-01までに」のような期日を置かない
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), 'ROADMAPに日付が入っている');
});

test('docs/MAINTAINING.md にリリース手順と初回公開の手順がある', () => {
  const text = read('docs/MAINTAINING.md');
  assert.match(text, /git tag/, 'タグの打ち方が無い');
  assert.match(text, /npm run changelog/, 'changelogの焼き直し手順が無い');
  assert.match(text, /CHANGELOG\.json/, 'CHANGELOG.jsonの更新手順が無い');
  assert.match(text, /health\.mjs/, 'VERSIONを上げる場所（health.mjs）が抜けている');
  assert.match(text, /git remote add origin/, '初回公開の手順が無い');
  assert.match(text, /erlen-eln/, '公開先のOrgが書かれていない');
  assert.match(text, /v1\.3\.0/, '最初に打つタグが書かれていない');
  assert.match(text, /filter-repo/, '著者メールの付け替え手順が無い');
  assert.match(text, /users\.noreply\.github\.com/, 'noreplyアドレスの選択肢が無い');
  assert.match(text, /Private vulnerability reporting/, 'GitHub側の設定チェックリストが無い');
});

// ------------------------------------------------------- 連絡先はGitHubへ寄せる

test('公開まわりのファイルにメールアドレスを書いていない', () => {
  // 連絡先は Issues と Security Advisories だけにする（アドレスを晒すと付け替えられない）。
  // test/dist-clean.test.mjs は特定ドメインだけを見るので、ここでは形の時点で落とす
  const MAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  const targets = [
    ...YAML_FILES,
    '.github/PULL_REQUEST_TEMPLATE.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'ROADMAP.md',
    'docs/MAINTAINING.md',
  ];
  const hits = [];
  for (const rel of targets) {
    const text = read(rel);
    MAIL.lastIndex = 0;
    for (let m = MAIL.exec(text); m; m = MAIL.exec(text)) hits.push(`${rel}: ${m[0]}`);
  }
  assert.deepEqual(hits, [], `メールアドレスが書かれている:\n${hits.join('\n')}`);
});

// --------------------------------------------------- 配布zipへの掛かり方

test('配布zipに .github を入れない（除外リストに載っている）', () => {
  // .github は上流リポジトリの運営のためのもの。展開して使う利用者には関係が無く、
  // 入れると「タグを打つとReleaseが作られる」設定まで配ってしまう
  const src = read('scripts/package.mjs');
  const block = /const EXCLUDE_DIRS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(block, 'package.mjs から EXCLUDE_DIRS を読み取れない');
  const dirs = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(dirs.includes('.github'), `EXCLUDE_DIRS に .github が無い: ${dirs.join(', ')}`);
  // 既存の除外も消えていないこと
  for (const name of ['.git', 'node_modules', '.wrangler', 'dist-zip', 'backups', 'logs']) {
    assert.ok(dirs.includes(name), `EXCLUDE_DIRS から ${name} が消えている`);
  }
});
