// 規制対応（コンプライアンス）の設定API: 方針（compliance_policies）と理由コード（reason_codes）、
// およびプロジェクトへの方針割り当て。
// 各関数は {status, data} を返すだけの素の関数（Responseを作らない）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること（test/tenant-scope.test.mjs が検査する）。
//
// COMPLIANCE_MODE="1" の環境でのみ有効。それ以外では全て 404（機能自体が無い扱い）。
// 例外: listReasonCodes だけは空配列を返す（画面が理由コードの選択肢を引いても壊れないように）。
// 権限: 方針・理由コードの書き込みと方針の一覧はオーナー専用、理由コードの一覧はログイン中なら誰でも
// （可否の判定は worker.mjs 側でまとめて行う）。
import { ulid } from '../ulid.mjs';
import { commitWithAudit } from '../audit.mjs';
import { complianceOn, POLICY_FLAGS } from '../compliance.mjs';

const POLICY_COLUMNS = `id, name, require_reason, require_review_signoff, approval_workflow,
  require_esign, require_reauth, session_max_min, idle_logout_min, is_tenant_default,
  created_at, updated_at`;
const REASON_CODE_COLUMNS = 'id, code, label_ja, label_en, sort_no, created_at';

function text(value, max = 4000) {
  return String(value ?? '').slice(0, max).trim();
}

// フラグの入力を 0/1 に正規化する（真偽値以外に 1/0 も受け付ける寛容さ）。
// データを壊せない入力なので、弾くのではなく寄せる
function flagOf(value) {
  return value ? 1 : 0;
}

// session_max_min / idle_logout_min の入力検査。null（制限なし）か整数だけを受け付ける。
// undefined は「指定なし」を意味するので呼び出し側で弾く。ここでは値の検査だけ
function intOrNull(value) {
  if (value === null) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n)) return { ok: false };
  return { ok: true, value: n };
}

// 方針の行を1件引く（論理削除済みは見えない＝存在しない扱い）
async function findPolicy(env, ctx, id) {
  return env.DB.prepare(
    `SELECT ${POLICY_COLUMNS} FROM compliance_policies
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
}

// 同名の行が既にあるか（論理削除済みも含めて見る）。
// UNIQUE(tenant_id, name) は削除済みの行にも効くので、ここで全行を見ないと
// 削除済みと同名の INSERT が制約違反で 500 になる
async function policyNameTaken(env, ctx, name, excludeId = null) {
  const row = await env.DB.prepare(
    `SELECT id FROM compliance_policies WHERE tenant_id = ? AND name = ?`
  ).bind(ctx.tenantId, name).first();
  return Boolean(row) && row.id !== excludeId;
}

// 他の方針の is_tenant_default を下ろすUPDATE（同じ batch に載せて使う）。
// テナント既定は常に1つだけにするための片付け
function clearOtherDefaults(env, ctx, keepId, nowIso) {
  return env.DB.prepare(
    `UPDATE compliance_policies SET is_tenant_default = 0, updated_at = ?
      WHERE tenant_id = ? AND id != ? AND is_tenant_default = 1 AND deleted_at IS NULL`
  ).bind(nowIso, ctx.tenantId, keepId);
}

// ---- 方針（compliance_policies） -------------------------------------

// 一覧（論理削除を除く）。オーナー専用
export async function listPolicies(env, ctx) {
  if (!complianceOn(env)) return { status: 404, data: { error: 'not_found' } };
  const { results } = await env.DB.prepare(
    `SELECT ${POLICY_COLUMNS} FROM compliance_policies
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`
  ).bind(ctx.tenantId).all();
  return { status: 200, data: { policies: results ?? [] } };
}

// 作成。name 必須・同名は409。フラグは真偽値、数値（session_max_min/idle_logout_min）は整数またはnull
export async function createPolicy(env, ctx, body, nowIso = new Date().toISOString()) {
  if (!complianceOn(env)) return { status: 404, data: { error: 'not_found' } };
  const name = text(body?.name, 200);
  if (!name) return { status: 400, data: { error: 'name_required' } };
  const nums = {};
  for (const f of ['session_max_min', 'idle_logout_min']) {
    const parsed = intOrNull(body?.[f] ?? null);
    if (!parsed.ok) return { status: 400, data: { error: 'invalid_number', field: f } };
    nums[f] = parsed.value;
  }
  if (await policyNameTaken(env, ctx, name)) {
    return { status: 409, data: { error: 'name_taken' } };
  }

  const id = ulid();
  const flags = Object.fromEntries(POLICY_FLAGS.map((f) => [f, flagOf(body?.[f])]));
  const isDefault = flagOf(body?.is_tenant_default);
  const statements = [
    env.DB.prepare(
      `INSERT INTO compliance_policies
         (id, tenant_id, name, require_reason, require_review_signoff, approval_workflow,
          require_esign, require_reauth, session_max_min, idle_logout_min,
          is_tenant_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ctx.tenantId, name,
      flags.require_reason, flags.require_review_signoff, flags.approval_workflow,
      flags.require_esign, flags.require_reauth,
      nums.session_max_min, nums.idle_logout_min, isDefault, nowIso, nowIso
    ),
  ];
  // 既定として作るなら、他の既定を同じ batch で下ろす（既定は1つだけ）
  if (isDefault) statements.push(clearOtherDefaults(env, ctx, id, nowIso));
  await commitWithAudit(env, ctx, statements, {
    action: 'policy.create', targetType: 'policy', targetId: id,
    after: {
      name,
      ...Object.fromEntries(POLICY_FLAGS.map((f) => [f, flags[f] === 1])),
      session_max_min: nums.session_max_min,
      idle_logout_min: nums.idle_logout_min,
      is_tenant_default: isDefault === 1,
    },
  }, nowIso);
  return { status: 201, data: { policy: await findPolicy(env, ctx, id) } };
}

// 変更。is_tenant_default を真にしたら、同じテナントの他の方針の同フラグを同じ batch で下ろす。
// その場合の監査 action は policy.set_tenant_default（既定の移動は追跡したい操作なので専用名にする）
export async function patchPolicy(env, ctx, id, body, nowIso = new Date().toISOString()) {
  if (!complianceOn(env)) return { status: 404, data: { error: 'not_found' } };
  const current = await findPolicy(env, ctx, id);
  if (!current) return { status: 404, data: { error: 'not_found' } };

  const sets = [];
  const args = [];
  // 監査の before/after には「変わった列」だけを入れる（真偽値は boolean で記録する）
  const before = {};
  const after = {};
  if (body?.name !== undefined) {
    const name = text(body.name, 200);
    if (!name) return { status: 400, data: { error: 'name_required' } };
    if (await policyNameTaken(env, ctx, name, id)) {
      return { status: 409, data: { error: 'name_taken' } };
    }
    sets.push('name = ?');
    args.push(name);
    if (name !== current.name) { before.name = current.name; after.name = name; }
  }
  for (const f of POLICY_FLAGS) {
    if (body?.[f] !== undefined) {
      const next = flagOf(body[f]);
      const prev = current[f] ? 1 : 0;
      sets.push(`${f} = ?`);
      args.push(next);
      if (next !== prev) { before[f] = prev === 1; after[f] = next === 1; }
    }
  }
  for (const f of ['session_max_min', 'idle_logout_min']) {
    if (body?.[f] !== undefined) {
      const parsed = intOrNull(body[f]);
      if (!parsed.ok) return { status: 400, data: { error: 'invalid_number', field: f } };
      sets.push(`${f} = ?`);
      args.push(parsed.value);
      const prev = current[f] ?? null;
      if (parsed.value !== prev) { before[f] = prev; after[f] = parsed.value; }
    }
  }
  if (body?.is_tenant_default !== undefined) {
    const next = flagOf(body.is_tenant_default);
    const prev = current.is_tenant_default ? 1 : 0;
    sets.push('is_tenant_default = ?');
    args.push(next);
    if (next !== prev) { before.is_tenant_default = prev === 1; after.is_tenant_default = next === 1; }
  }
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };
  sets.push('updated_at = ?');
  args.push(nowIso, id, ctx.tenantId);

  const becomingDefault = body?.is_tenant_default !== undefined && flagOf(body.is_tenant_default) === 1;
  const statements = [env.DB.prepare(
    `UPDATE compliance_policies SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args)];
  if (becomingDefault) statements.push(clearOtherDefaults(env, ctx, id, nowIso));

  const { results } = await commitWithAudit(env, ctx, statements, {
    action: becomingDefault ? 'policy.set_tenant_default' : 'policy.update',
    targetType: 'policy', targetId: id, before, after,
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { policy: await findPolicy(env, ctx, id) } };
}

// 論理削除。割り当て中のプロジェクトがあれば 409（参照がぶら下がったまま残るのを防ぐ）
export async function deletePolicy(env, ctx, id, nowIso = new Date().toISOString()) {
  if (!complianceOn(env)) return { status: 404, data: { error: 'not_found' } };
  const current = await findPolicy(env, ctx, id);
  if (!current) return { status: 404, data: { error: 'not_found' } };

  const used = await env.DB.prepare(
    `SELECT id FROM projects
      WHERE tenant_id = ? AND compliance_policy_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(ctx.tenantId, id).first();
  if (used) return { status: 409, data: { error: 'policy_in_use' } };

  const stmt = env.DB.prepare(
    `UPDATE compliance_policies SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'policy.delete', targetType: 'policy', targetId: id,
    before: {
      name: current.name,
      ...Object.fromEntries(POLICY_FLAGS.map((f) => [f, Boolean(current[f])])),
      is_tenant_default: Boolean(current.is_tenant_default),
    },
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id } };
}

// ---- 理由コード（reason_codes） ----------------------------------------

// 一覧（論理削除を除く・sort_no 順）。ログイン中なら誰でも読める。
// 規制モードが無い環境でも空配列を返す（画面が選択肢を引いても壊れないように）
export async function listReasonCodes(env, ctx) {
  if (!complianceOn(env)) return { status: 200, data: { reason_codes: [] } };
  const { results } = await env.DB.prepare(
    `SELECT ${REASON_CODE_COLUMNS} FROM reason_codes
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY sort_no ASC, created_at ASC`
  ).bind(ctx.tenantId).all();
  return { status: 200, data: { reason_codes: results ?? [] } };
}

// code の重複検査。UNIQUE(tenant_id, code) は削除済みにも効くので全行を見る
async function reasonCodeTaken(env, ctx, code, excludeId = null) {
  const row = await env.DB.prepare(
    `SELECT id FROM reason_codes WHERE tenant_id = ? AND code = ?`
  ).bind(ctx.tenantId, code).first();
  return Boolean(row) && row.id !== excludeId;
}

async function findReasonCode(env, ctx, id) {
  return env.DB.prepare(
    `SELECT ${REASON_CODE_COLUMNS} FROM reason_codes
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
}

// sort_no の入力を整える（notebooks の sort_order と同じく、変な値は 0 に寄せる）
function sortNoOf(value) {
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
}

// 作成。code と label_ja は必須。code の重複は 409
export async function createReasonCode(env, ctx, body, nowIso = new Date().toISOString()) {
  if (!complianceOn(env)) return { status: 404, data: { error: 'not_found' } };
  const code = text(body?.code, 100);
  if (!code) return { status: 400, data: { error: 'code_required' } };
  const labelJa = text(body?.label_ja, 200);
  if (!labelJa) return { status: 400, data: { error: 'label_ja_required' } };
  if (await reasonCodeTaken(env, ctx, code)) {
    return { status: 409, data: { error: 'code_taken' } };
  }
  const id = ulid();
  const labelEn = text(body?.label_en, 200);
  const sortNo = sortNoOf(body?.sort_no);
  const stmt = env.DB.prepare(
    `INSERT INTO reason_codes (id, tenant_id, code, label_ja, label_en, sort_no, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ctx.tenantId, code, labelJa, labelEn, sortNo, nowIso);
  await commitWithAudit(env, ctx, [stmt], {
    action: 'reason_code.create', targetType: 'reason_code', targetId: id,
    after: { code, label_ja: labelJa, label_en: labelEn, sort_no: sortNo },
  }, nowIso);
  return { status: 201, data: { reason_code: await findReasonCode(env, ctx, id) } };
}

// 変更。code を変えるときも重複は 409
export async function patchReasonCode(env, ctx, id, body, nowIso = new Date().toISOString()) {
  if (!complianceOn(env)) return { status: 404, data: { error: 'not_found' } };
  const current = await findReasonCode(env, ctx, id);
  if (!current) return { status: 404, data: { error: 'not_found' } };

  const sets = [];
  const args = [];
  const before = {};
  const after = {};
  if (body?.code !== undefined) {
    const code = text(body.code, 100);
    if (!code) return { status: 400, data: { error: 'code_required' } };
    if (await reasonCodeTaken(env, ctx, code, id)) {
      return { status: 409, data: { error: 'code_taken' } };
    }
    sets.push('code = ?');
    args.push(code);
    if (code !== current.code) { before.code = current.code; after.code = code; }
  }
  if (body?.label_ja !== undefined) {
    const labelJa = text(body.label_ja, 200);
    if (!labelJa) return { status: 400, data: { error: 'label_ja_required' } };
    sets.push('label_ja = ?');
    args.push(labelJa);
    if (labelJa !== current.label_ja) { before.label_ja = current.label_ja; after.label_ja = labelJa; }
  }
  if (body?.label_en !== undefined) {
    const labelEn = text(body.label_en, 200);
    sets.push('label_en = ?');
    args.push(labelEn);
    if (labelEn !== (current.label_en ?? '')) {
      before.label_en = current.label_en ?? '';
      after.label_en = labelEn;
    }
  }
  if (body?.sort_no !== undefined) {
    const sortNo = sortNoOf(body.sort_no);
    sets.push('sort_no = ?');
    args.push(sortNo);
    if (sortNo !== current.sort_no) { before.sort_no = current.sort_no; after.sort_no = sortNo; }
  }
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };
  const stmt = env.DB.prepare(
    `UPDATE reason_codes SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args, id, ctx.tenantId);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'reason_code.update', targetType: 'reason_code', targetId: id, before, after,
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { reason_code: await findReasonCode(env, ctx, id) } };
}

// 論理削除
export async function deleteReasonCode(env, ctx, id, nowIso = new Date().toISOString()) {
  if (!complianceOn(env)) return { status: 404, data: { error: 'not_found' } };
  const current = await findReasonCode(env, ctx, id);
  if (!current) return { status: 404, data: { error: 'not_found' } };
  const stmt = env.DB.prepare(
    `UPDATE reason_codes SET deleted_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, id, ctx.tenantId);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'reason_code.delete', targetType: 'reason_code', targetId: id,
    before: { code: current.code, label_ja: current.label_ja },
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id } };
}

// ---- プロジェクトへの方針割り当て ---------------------------------------
// PUT /api/projects/:id/policy の中身。本文は { policy_id: string | null }。
// null（または空文字）は「方針を外す」。存在しない・論理削除済みの方針は 400
export async function putProjectPolicy(env, ctx, projectId, body, nowIso = new Date().toISOString()) {
  if (!complianceOn(env)) return { status: 404, data: { error: 'not_found' } };
  if (body?.policy_id === undefined) {
    return { status: 400, data: { error: 'policy_id_required' } };
  }
  const project = await env.DB.prepare(
    `SELECT id, name, compliance_policy_id FROM projects
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(projectId, ctx.tenantId).first();
  if (!project) return { status: 404, data: { error: 'not_found' } };

  // 割り当て先の方針。null は「外す」
  let policyId = null;
  let policyName = null;
  const raw = text(body.policy_id, 100);
  if (raw) {
    const pol = await env.DB.prepare(
      `SELECT id, name FROM compliance_policies
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
    ).bind(raw, ctx.tenantId).first();
    if (!pol) return { status: 400, data: { error: 'policy_not_found' } };
    policyId = pol.id;
    policyName = pol.name;
  }

  // 監査の before/after には { policy_id, policy_name } を入れる。
  // 外す前の方針が削除済みでも名前が残るよう、before の引き当ては deleted_at を見ない
  const beforePolicyId = project.compliance_policy_id ?? null;
  let beforePolicyName = null;
  if (beforePolicyId) {
    const prev = await env.DB.prepare(
      `SELECT name FROM compliance_policies WHERE id = ? AND tenant_id = ?`
    ).bind(beforePolicyId, ctx.tenantId).first();
    beforePolicyName = prev?.name ?? null;
  }

  const stmt = env.DB.prepare(
    `UPDATE projects SET compliance_policy_id = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(policyId, nowIso, projectId, ctx.tenantId);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'project.policy_assign', targetType: 'project', targetId: projectId,
    before: { policy_id: beforePolicyId, policy_name: beforePolicyName },
    after: { policy_id: policyId, policy_name: policyName },
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id: projectId, policy_id: policyId } };
}
