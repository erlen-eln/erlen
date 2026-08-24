// 印刷用レポート。1ページぶんの記録を、そのままブラウザで印刷できる完結HTMLに組む。
// 姉妹アプリ elnectmobile の src/services/pageReportExport.ts（buildReportHtml）の構成を
// Worker向けに移した版。あちらはPDF化前提の縦積みだったが、ここはA4横目に読める表にしている。
//
// このファイルはHTMLの文字列を作るだけで、Responseは作らない（api層の約束）。
// text/html として返すのは worker.mjs の役目。
//
// XSSについて
//   ・利用者が打った文字列は例外なく escapeHtml を通す。
//   ・分子のSVGだけは中身を持つHTMLとして埋める（構造式はSVGでしか出せない）。
//     これはKetcherが自分で生成したものだが、DBに入っている以上は無検査で信用しない。
//     safeSvg() でスクリプトらしきものを含む場合は丸ごと捨てる。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
//
// 見えないノートブックのページはレポートも出せない（src/access.mjs）。
// 印刷経路は画面を経由せず直接URLで叩けるので、ここを外すと閲覧制限が丸ごと素通りになる。
import { pageVisibility } from '../access.mjs';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 構造式SVGの検問。スクリプトを持ち込めるものが1つでもあれば描画しない（空文字を返す）。
// 構造式が出ないだけで、レポートの他の内容は全部出る。
//
// Ketcherが吐くSVGは XML宣言（<?xml ... ?>）から始まることがある。
// HTMLの中では宣言は邪魔なので、<svg から始まる形に削ってから検査する。
// 画面側（web/src/components/safeSvg.ts）と同じ判定にしてある。
export function safeSvg(value) {
  const text = String(value ?? '');
  const at = text.indexOf('<svg');
  if (at < 0) return '';
  // <svg より前に本文（宣言・空白以外）があるものは信用しない
  if (/[^\s]/.test(text.slice(0, at).replace(/<\?xml[^>]*\?>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, ''))) {
    return '';
  }
  const svg = text.slice(at).trim();
  if (/<script|<foreignObject|javascript:|\son\w+\s*=/i.test(svg)) return '';
  return svg;
}

// 表示言語。既定は日本語（購入者の大半は国内ラボのため）。?lang=en のときだけ英語にする。
// 未知の値は 'ja' に落とす（レポートが空白になるより日本語で出る方が安全）。
const STRINGS = {
  ja: {
    noRecord: '記載なし',
    tableHead: [
      '構造式', '名前', 'CAS番号', '分子量<br>g/mol', '当量', '質量<br>mg', 'mol<br>mmol',
      '体積<br>mL', '濃度<br>M', '密度<br>g/mL', '純度<br>%',
    ],
    yieldHead: '収率<br>%',
    print: '印刷する',
    brand: 'Erlen / 電子実験ノート',
    metaNotebook: 'ノートブック',
    metaDate: '実験日',
    metaRecorder: '記録者',
    metaStatus: '状態',
    metaUpdated: '最終更新',
    metaOutput: '出力日時',
    statusClosed: '確定済み',
    statusDraft: '作成中',
    reactants: '原料 (Reactants)',
    products: '生成物 (Products)',
    content: '本文',
    attachments: '添付ファイル',
    noAttachments: '添付はありません',
    reference: (name) => `基準物質: ${name}`,
    referenceTheoretical: (moles) => `（${moles} mmol を理論収量とする）`,
    noReference: '基準物質は指定されていません（収率は保存済みの値を表示します）。',
    noName: '(名前なし)',
    attachSize: (size, mime) => `（${size}${mime ? ` / ${mime}` : ''}）`,
  },
  en: {
    noRecord: 'None recorded',
    tableHead: [
      'Structure', 'Name', 'CAS No.', 'MW<br>g/mol', 'Equiv.', 'Mass<br>mg', 'mol<br>mmol',
      'Volume<br>mL', 'Molarity<br>M', 'Density<br>g/mL', 'Purity<br>%',
    ],
    yieldHead: 'Yield<br>%',
    print: 'Print',
    brand: 'Erlen / Electronic Lab Notebook',
    metaNotebook: 'Notebook',
    metaDate: 'Experiment date',
    metaRecorder: 'Recorded by',
    metaStatus: 'Status',
    metaUpdated: 'Last updated',
    metaOutput: 'Generated at',
    statusClosed: 'Finalized',
    statusDraft: 'In progress',
    reactants: 'Reactants',
    products: 'Products',
    content: 'Notes',
    attachments: 'Attachments',
    noAttachments: 'No attachments',
    reference: (name) => `Reference substance: ${name}`,
    referenceTheoretical: (moles) => ` (${moles} mmol taken as the theoretical yield)`,
    noReference: 'No reference substance is set (yield shows the saved value only).',
    noName: '(unnamed)',
    attachSize: (size, mime) => `(${size}${mime ? ` / ${mime}` : ''})`,
  },
};

function reportStrings(lang) {
  return STRINGS[lang] ?? STRINGS.ja;
}

function num(value, decimals) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return escapeHtml(decimals === undefined ? String(n) : n.toFixed(decimals));
}

// 生成物の収率。基準物質（原料でis_referenceが立っている行）のmmolを理論収量とみなす。
// 保存済みの yield_percent があればそれを優先する（画面で手直しできる値なので）
export function yieldPercent(molecule, referenceMoles) {
  if (molecule.yield_percent !== null && molecule.yield_percent !== undefined) {
    return Number(molecule.yield_percent);
  }
  const moles = molecule.moles === null || molecule.moles === undefined ? null : Number(molecule.moles);
  if (moles === null || !referenceMoles || referenceMoles <= 0) return null;
  return (moles / referenceMoles) * 100;
}

const REPORT_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", system-ui, sans-serif;
    color: #1b1f24; margin: 0; padding: 24px; line-height: 1.6;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 1px solid #d7dde5; padding-bottom: 4px; }
  .brand { font-size: 11px; color: #6b7684; letter-spacing: .08em; }
  .meta { display: grid; grid-template-columns: 90px 1fr 90px 1fr; gap: 4px 10px; font-size: 11px; margin: 12px 0 4px; }
  .label { color: #6b7684; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th, td { border: 1px solid #d7dde5; padding: 4px 5px; text-align: left; vertical-align: middle; }
  th { background: #f2f6fb; font-weight: 700; white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.structure { width: 96px; padding: 2px; text-align: center; }
  td.structure svg { max-width: 92px; max-height: 72px; height: auto; width: auto; }
  /* 画像が無い行のSMILES。狭い枠に収めるので折り返しと等幅で読ませる */
  td.structure .smiles {
    display: block; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 8.5px; line-height: 1.35; color: #4a5563; overflow-wrap: anywhere;
  }
  .name { overflow-wrap: anywhere; }
  tbody tr { break-inside: avoid; page-break-inside: avoid; }
  table, .content, .attachments { break-inside: auto; }
  h2 { break-after: avoid; page-break-after: avoid; }
  .content { white-space: pre-wrap; font-size: 12px; border: 1px solid #eef1f5; padding: 10px; border-radius: 4px; }
  .empty { color: #8a94a1; font-size: 11px; }
  ul { margin: 0; padding-left: 18px; font-size: 11px; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid #c3ccd8; }
  .toolbar { margin-bottom: 14px; }
  .toolbar button { font: inherit; font-size: 12px; padding: 6px 14px; cursor: pointer; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
  /* 画面（スマホ）で開いたとき。紙のレイアウトは変えず、表だけ横に逃がす */
  @media screen and (max-width: 640px) {
    body { padding: 12px; }
    .meta { grid-template-columns: 78px 1fr; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .table-wrap table { min-width: 640px; }
    .toolbar button { min-height: 44px; padding: 10px 18px; }
  }
`;

function moleculeTable(molecules, s, { showYield = false, referenceMoles = null } = {}) {
  if (!molecules.length) return `<p class="empty">${s.noRecord}</p>`;
  const head = [...s.tableHead, ...(showYield ? [s.yieldHead] : [])];
  const rows = molecules.map((m) => {
    const svg = safeSvg(m.svg);
    // 画像が無い行の逃げ道。
    // 構造式はブラウザ側（RDKit.js）で描いているので、ここ（Worker）では絵を作れない。
    // SMILESがあるならせめて文字で出す。空欄よりは構造が伝わる
    // （画面で試薬を開き直すか、試薬マスタの「構造式を一括生成」を押せば画像が保存される）
    const smilesText = (m.smiles ?? '').trim();
    const structure = svg
      || (smilesText ? `<span class="smiles">${escapeHtml(smilesText)}</span>` : '<span class="empty">—</span>');
    return `<tr>
        <td class="structure">${structure}</td>
        <td class="name">${escapeHtml(m.name)}${
      m.smiles ? `<br><span class="empty">${escapeHtml(m.smiles)}</span>` : ''
    }</td>
        <td>${escapeHtml(m.cas_number)}</td>
        <td class="num">${num(m.molecular_weight, 2)}</td>
        <td class="num">${num(m.equivalents, 2)}</td>
        <td class="num">${num(m.mass, 1)}</td>
        <td class="num">${num(m.moles, 3)}</td>
        <td class="num">${num(m.volume, 2)}</td>
        <td class="num">${num(m.molarity, 2)}</td>
        <td class="num">${num(m.density, 3)}</td>
        <td class="num">${num(m.purity, 0)}</td>
        ${showYield ? `<td class="num">${num(yieldPercent(m, referenceMoles), 1)}</td>` : ''}
      </tr>`;
  });
  // ラッパは画面で見たとき用（スマホでは12列が入りきらないので表だけ横スクロールさせる）。
  // 印刷時は overflow を戻すので、紙の出力は今までと同じ
  return `<div class="table-wrap"><table>
      <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
}

function formatBytes(size) {
  const n = Number(size);
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// GET /api/pages/:id/report の中身。{status, data:{html, title}} を返す
// lang: 'ja'（既定）か 'en'。それ以外は 'ja' 扱い（worker.mjs が ?lang= をそのまま渡してくる）
export async function buildPageReport(env, ctx, pageId, nowIso = new Date().toISOString(), lang = 'ja') {
  const s = reportStrings(lang);
  const htmlLang = lang === 'en' ? 'en' : 'ja';
  const vis = pageVisibility(ctx, 'p');
  const page = await env.DB.prepare(
    `SELECT p.id, p.notebook_id, p.title, p.content, p.status, p.experiment_date,
            p.created_at, p.updated_at, n.title AS notebook_title
       FROM pages p
       LEFT JOIN notebooks n ON n.id = p.notebook_id AND n.tenant_id = p.tenant_id
      WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
  if (!page) return { status: 404, data: { error: 'not_found' } };

  const molecules = (await env.DB.prepare(
    `SELECT role, name, smiles, svg, cas_number, molecular_weight, density, purity,
            equivalents, mass, moles, volume, molarity, is_reference, yield_percent
       FROM molecules
      WHERE tenant_id = ? AND page_id = ? AND deleted_at IS NULL
      ORDER BY sort_order ASC, created_at ASC`
  ).bind(ctx.tenantId, pageId).all()).results ?? [];

  const attachments = (await env.DB.prepare(
    `SELECT file_name, file_size, mime_type, created_at
       FROM attachments
      WHERE tenant_id = ? AND page_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`
  ).bind(ctx.tenantId, pageId).all()).results ?? [];

  const reactants = molecules.filter((m) => m.role !== 'product');
  const products = molecules.filter((m) => m.role === 'product');
  const reference = reactants.find((m) => m.is_reference);
  const referenceMoles = reference && reference.moles !== null ? Number(reference.moles) : null;

  const html = `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(page.title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="toolbar"><button type="button" onclick="window.print()">${s.print}</button></div>
<div class="brand">${s.brand}</div>
<h1>${escapeHtml(page.title)}</h1>
<div class="meta">
  <div class="label">${s.metaNotebook}</div><div>${escapeHtml(page.notebook_title ?? '')}</div>
  <div class="label">${s.metaDate}</div><div>${escapeHtml(page.experiment_date || '—')}</div>
  <div class="label">${s.metaRecorder}</div><div>${escapeHtml(ctx.name || ctx.email || '')}</div>
  <div class="label">${s.metaStatus}</div><div><span class="badge">${page.status === 'closed' ? s.statusClosed : s.statusDraft}</span></div>
  <div class="label">${s.metaUpdated}</div><div>${escapeHtml(page.updated_at)}</div>
  <div class="label">${s.metaOutput}</div><div>${escapeHtml(nowIso)}</div>
</div>

<h2>${s.reactants}</h2>
${moleculeTable(reactants, s)}
${reference ? `<p class="empty">${s.reference(escapeHtml(reference.name || s.noName))}${
    referenceMoles !== null ? s.referenceTheoretical(referenceMoles.toFixed(3)) : ''
  }</p>` : `<p class="empty">${s.noReference}</p>`}

<h2>${s.products}</h2>
${moleculeTable(products, s, { showYield: true, referenceMoles })}

<h2>${s.content}</h2>
<div class="content">${escapeHtml(page.content) || `<span class="empty">${s.noRecord}</span>`}</div>

<h2>${s.attachments}</h2>
<div class="attachments">${attachments.length === 0
    ? `<p class="empty">${s.noAttachments}</p>`
    : `<ul>${attachments.map((a) => `<li>${escapeHtml(a.file_name)}`
      + ` <span class="empty">${s.attachSize(escapeHtml(formatBytes(a.file_size)), escapeHtml(a.mime_type || ''))}</span></li>`).join('')}</ul>`}</div>
</body>
</html>`;

  return { status: 200, data: { html, title: page.title } };
}
