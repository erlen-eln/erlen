// 監査証跡の計装カバレッジ。
// 「書き込みAPIなのに監査が無い」状態を2方向から止める:
//   静的 … src/api/*.mjs の書き込み系exportが必ず commitWithAudit( を含む
//   動的 … 主要な書き込みAPIを1回ずつ呼び、audit_events がちょうど +1 増える
// 🔴「batch の途中で失敗したら業務側の行も残らない」は書かない
//    （test/d1-adapter.mjs の batch はトランザクションを模していないので再現しない）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnv, addMember } from './d1-adapter.mjs';
import { createNotebook, patchNotebook, deleteNotebook } from '../src/api/notebooks.mjs';
import { createProject, patchProject, putProjectMembers, deleteProject } from '../src/api/projects.mjs';
import { createInvitation, revokeInvitation, patchMember, removeMember } from '../src/api/members.mjs';
import { createAttachment, deleteAttachment } from '../src/api/attachments.mjs';
import { createReagent, bulkCreateReagents, patchReagent, deleteReagent } from '../src/api/reagents.mjs';
import { createStock, patchStock, deleteStock } from '../src/api/stocks.mjs';
import { createEquipment, bulkCreateEquipments, patchEquipment, deleteEquipment } from '../src/api/equipments.mjs';
import { createPage, patchPage, deletePage } from '../src/api/pages.mjs';
import { saveMolecules } from '../src/api/molecules.mjs';
import { resolveLogin } from '../src/session.mjs';
import {
  createPolicy, patchPolicy, deletePolicy, putProjectPolicy,
  createReasonCode, patchReasonCode, deleteReasonCode,
} from '../src/api/policies.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'src', 'api');

// 書き込み系とみなす関数名の先頭（指示書の一覧）
const WRITE_VERBS = ['create', 'patch', 'update', 'delete', 'remove', 'revoke', 'put', 'save', 'bulk'];

// export した関数の名前と本体を拾う（関数の終端は次の `export` の先頭）。
// test/tenant-scope.test.mjs と同じく「字面で見る」静的検査。
function exportedFunctions(source) {
  const bounds = [...source.matchAll(/\nexport\s+/g)].map((m) => m.index + 1);
  const out = [];
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    const end = bounds.find((b) => b > m.index) ?? source.length;
    out.push({ name: m[1], body: source.slice(m.index, end) });
  }
  return out;
}

test('書き込み系exportは全て commitWithAudit( を含む（抜けの作り込み防止）', () => {
  const offenders = [];
  let writeCount = 0;
  for (const f of readdirSync(API_DIR)) {
    if (!f.endsWith('.mjs')) continue;
    for (const fn of exportedFunctions(readFileSync(path.join(API_DIR, f), 'utf8'))) {
      if (!WRITE_VERBS.some((v) => fn.name.startsWith(v))) continue;
      writeCount += 1;
      if (!fn.body.includes('commitWithAudit(')) offenders.push(`${f}: ${fn.name}`);
    }
  }
  // 抜き出しが空振りして0件緑になっていないことの確認
  assert.ok(writeCount >= 20, `書き込み系exportが少なすぎる（抜き出し失敗の疑い）: ${writeCount}本`);
  assert.deepEqual(offenders, [], `監査の無い書き込み関数:\n${offenders.join('\n')}`);
});

// ---- 動的: 呼ぶたびに audit_events がちょうど1増える -------------------
const auditCount = (DB) => DB.__raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;

async function expectOneMore(DB, label, fn) {
  const before = auditCount(DB);
  const out = await fn();
  // api層は {status, data}、session.mjs の resolveLogin は {ok, user} を返す
  const succeeded = out.status === undefined ? out.ok === true : out.status < 300;
  assert.ok(succeeded, `${label}: 呼び出しが失敗している (${JSON.stringify(out).slice(0, 120)})`);
  assert.equal(auditCount(DB), before + 1, `${label}: 監査がちょうど1件増える`);
  return out;
}

test('主要な書き込みAPIは1回の呼び出しで監査がちょうど1件増える', async () => {
  const { env, ctx, DB } = createTestEnv();
  const NOW = '2026-07-10T00:00:00.000Z';

  // ---- ノートブック・ページ・分子・添付 ----
  const nb = await expectOneMore(DB, 'notebook.create',
    () => createNotebook(env, ctx, { title: '検査帳' }));
  const nbId = nb.data.notebook.id;
  await expectOneMore(DB, 'notebook.update',
    () => patchNotebook(env, ctx, nbId, { title: '検査帳・改' }));
  const pg = await expectOneMore(DB, 'page.create',
    () => createPage(env, ctx, nbId, { title: 'ページ1' }));
  const pageId = pg.data.page.id;
  await expectOneMore(DB, 'page.update',
    () => patchPage(env, ctx, pageId, { content: '本文v1' }));
  await expectOneMore(DB, 'molecules.replace',
    () => saveMolecules(env, ctx, pageId, { molecules: [{ name: '水', molecular_weight: 18 }] }));
  const att = await expectOneMore(DB, 'attachment.create',
    () => createAttachment(env, ctx, pageId, {
      bytes: new Uint8Array([1, 2, 3]).buffer, contentType: 'text/plain', fileName: 'memo.txt',
    }));
  await expectOneMore(DB, 'attachment.delete',
    () => deleteAttachment(env, ctx, att.data.attachment.id));
  await expectOneMore(DB, 'page.delete', () => deletePage(env, ctx, pageId));
  await expectOneMore(DB, 'notebook.delete', () => deleteNotebook(env, ctx, nbId));

  // ---- プロジェクト ----
  const pj = await expectOneMore(DB, 'project.create',
    () => createProject(env, ctx, { name: '案件A' }));
  const pjId = pj.data.project.id;
  addMember(env, { id: 'sub-m1', email: 'm1@example.com' }); // 前提データ（監査は書かない）
  await expectOneMore(DB, 'project.members_replace',
    () => putProjectMembers(env, ctx, pjId, { user_ids: ['sub-m1'] }));
  await expectOneMore(DB, 'project.update',
    () => patchProject(env, ctx, pjId, { description: '説明' }));
  await expectOneMore(DB, 'project.delete', () => deleteProject(env, ctx, pjId));

  // ---- 招待・メンバー ----
  const inv = await expectOneMore(DB, 'invitation.create',
    () => createInvitation(env, ctx, { email: 'inv1@example.com', role: 'editor' }));
  await expectOneMore(DB, 'invitation.revoke',
    () => revokeInvitation(env, ctx, inv.data.invitation.id));
  const inv2 = await expectOneMore(DB, 'invitation.create(2)',
    () => createInvitation(env, ctx, { email: 'inv2@example.com', role: 'viewer' }));
  assert.ok(inv2.data.invitation.id);
  const accepted = await expectOneMore(DB, 'invitation.accept',
    () => resolveLogin(env, { sub: 'sub-new', email: 'inv2@example.com', name: '' }, NOW));
  assert.equal(accepted.ok, true);
  await expectOneMore(DB, 'member.role_change',
    () => patchMember(env, ctx, 'sub-new', { role: 'editor' }));
  await expectOneMore(DB, 'member.promote_owner',
    () => patchMember(env, ctx, 'sub-new', { role: 'owner' }));
  await expectOneMore(DB, 'member.remove',
    () => removeMember(env, ctx, 'sub-new'));

  // ---- 台帳3種 ----
  const rg = await expectOneMore(DB, 'reagent.create',
    () => createReagent(env, ctx, { name: 'エタノール' }));
  await expectOneMore(DB, 'reagent.bulk',
    () => bulkCreateReagents(env, ctx, { items: [{ name: 'メタノール' }] }));
  await expectOneMore(DB, 'reagent.update',
    () => patchReagent(env, ctx, rg.data.reagent.id, { purity: 99.5 }));
  await expectOneMore(DB, 'reagent.delete',
    () => deleteReagent(env, ctx, rg.data.reagent.id));

  const st = await expectOneMore(DB, 'stock.create',
    () => createStock(env, ctx, { custom_reagent_name: '自作試薬X', storage_location: '棚1' }));
  await expectOneMore(DB, 'stock.update',
    () => patchStock(env, ctx, st.data.stock.id, { is_opened: true }));
  await expectOneMore(DB, 'stock.delete',
    () => deleteStock(env, ctx, st.data.stock.id));

  const eq = await expectOneMore(DB, 'equipment.create',
    () => createEquipment(env, ctx, { name: 'HPLC' }));
  await expectOneMore(DB, 'equipment.bulk',
    () => bulkCreateEquipments(env, ctx, { items: [{ name: '分析天秤' }] }));
  await expectOneMore(DB, 'equipment.update',
    () => patchEquipment(env, ctx, eq.data.equipment.id, { notes: '定期点検済み' }));
  await expectOneMore(DB, 'equipment.delete',
    () => deleteEquipment(env, ctx, eq.data.equipment.id));
});

test('規制まわりの書き込みAPIも1回の呼び出しで監査がちょうど1件増える（COMPLIANCE_MODE="1"）', async () => {
  const { env, ctx, DB } = createTestEnv();
  env.COMPLIANCE_MODE = '1';
  const NOW = '2026-07-11T00:00:00.000Z';

  // ---- 方針（compliance_policies） ----
  const pol = await expectOneMore(DB, 'policy.create',
    () => createPolicy(env, ctx, { name: '方針A' }, NOW));
  const polId = pol.data.policy.id;
  await expectOneMore(DB, 'policy.update',
    () => patchPolicy(env, ctx, polId, { require_reason: true }, NOW));
  const pol2 = await expectOneMore(DB, 'policy.create(2)',
    () => createPolicy(env, ctx, { name: '方針B' }, NOW));
  // 既定を立てる変更は専用の action で記録する（既定の移動は追跡したい操作）
  await expectOneMore(DB, 'policy.set_tenant_default',
    () => patchPolicy(env, ctx, pol2.data.policy.id, { is_tenant_default: true }, NOW));

  // ---- プロジェクトへの割り当て ----
  const pj = await expectOneMore(DB, 'project.create',
    () => createProject(env, ctx, { name: '案件C' }));
  const pjId = pj.data.project.id;
  await expectOneMore(DB, 'project.policy_assign',
    () => putProjectPolicy(env, ctx, pjId, { policy_id: polId }, NOW));
  await expectOneMore(DB, 'project.policy_assign(解除)',
    () => putProjectPolicy(env, ctx, pjId, { policy_id: null }, NOW));

  // ---- 削除（割り当てを外してから） ----
  await expectOneMore(DB, 'policy.delete',
    () => deletePolicy(env, ctx, polId, NOW));

  // ---- 理由コード（reason_codes） ----
  const rc = await expectOneMore(DB, 'reason_code.create',
    () => createReasonCode(env, ctx, { code: 'FIX', label_ja: '修正' }, NOW));
  const rcId = rc.data.reason_code.id;
  await expectOneMore(DB, 'reason_code.update',
    () => patchReasonCode(env, ctx, rcId, { label_ja: '修正（再）' }, NOW));
  await expectOneMore(DB, 'reason_code.delete',
    () => deleteReasonCode(env, ctx, rcId, NOW));
});
