// 規制対応（コンプライアンス）の器。「どの規制対応を掛けるか」をプロジェクト単位で選べるようにする。
// このファイルは「効いている方針を解決する」だけを担当する（設定のCRUDは src/api/policies.mjs）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること（test/tenant-scope.test.mjs が検査する）。
//
// 元栓は vars の COMPLIANCE_MODE。"1" でない環境では全ての解決が NO_POLICY を返す
// （＝この機能は存在しない扱い。既存の導入者の挙動を1文字も変えないための安全弁）。

// 規制モードの元栓。wrangler.jsonc の vars.COMPLIANCE_MODE が "1" のときだけ true。
export function complianceOn(env) {
  return env?.COMPLIANCE_MODE === '1';
}

// 方針が持つ真偽値フラグの一覧（compliance_policies の列名と一致）。
// 値の検査やフォームの項目列挙はここを正本にする
export const POLICY_FLAGS = [
  'require_reason',
  'require_review_signoff',
  'approval_workflow',
  'require_esign',
  'require_reauth',
];

// 「方針なし」を表す固定オブジェクト。全フラグ false・name ''。
// 解決の結果が「何も効いていない」ときは必ずこれを返す（null ではなく。
// 呼び出し側が policy.require_reason のように素直に読めるようにする）。
// 凍結してあるので書き換えても効かない＝共通の NO_POLICY が汚れない
export const NO_POLICY = Object.freeze({
  id: null,
  name: '',
  require_reason: false,
  require_review_signoff: false,
  approval_workflow: false,
  require_esign: false,
  require_reauth: false,
  session_max_min: null,
  idle_logout_min: null,
  is_tenant_default: false,
});

// ノートブック → プロジェクト → 割り当てられた方針、を1本のJOINでたどる。
// nb.project_id が NULL（プロジェクトに属さない）・プロジェクトに方針が無い・
// 方針が論理削除済み、のいずれでもJOINは0行になる＝NO_POLICY に落ちる。
// 途中の行（ノートブック・プロジェクト）が論理削除済みのときも方針は効かないものとする
const POLICY_VIA_NOTEBOOK = `
  SELECT p.*
    FROM notebooks nb
    JOIN projects pj
      ON pj.id = nb.project_id AND pj.tenant_id = nb.tenant_id
    JOIN compliance_policies p
      ON p.id = pj.compliance_policy_id AND p.tenant_id = pj.tenant_id
   WHERE nb.tenant_id = ?
     AND nb.deleted_at IS NULL AND pj.deleted_at IS NULL AND p.deleted_at IS NULL`;

// ページに効いている方針。ページ → そのノートブック → そのプロジェクト → 方針 の順にたどる
export async function policyForPage(env, ctx, pageId) {
  if (!complianceOn(env)) return NO_POLICY;
  const row = await env.DB.prepare(
    `SELECT p.*
       FROM pages pg
       JOIN notebooks nb
         ON nb.id = pg.notebook_id AND nb.tenant_id = pg.tenant_id
       JOIN projects pj
         ON pj.id = nb.project_id AND pj.tenant_id = nb.tenant_id
       JOIN compliance_policies p
         ON p.id = pj.compliance_policy_id AND p.tenant_id = pj.tenant_id
      WHERE pg.id = ? AND pg.tenant_id = ?
        AND pg.deleted_at IS NULL AND nb.deleted_at IS NULL
        AND pj.deleted_at IS NULL AND p.deleted_at IS NULL`
  ).bind(pageId, ctx.tenantId).first();
  return row ?? NO_POLICY;
}

// ノートブックに効いている方針（ノートブック自体の削除など、ページを経由しない操作用）
export async function policyForNotebook(env, ctx, notebookId) {
  if (!complianceOn(env)) return NO_POLICY;
  const row = await env.DB.prepare(
    `${POLICY_VIA_NOTEBOOK} AND nb.id = ?`
  ).bind(ctx.tenantId, notebookId).first();
  return row ?? NO_POLICY;
}

// テナント全体の操作（メンバー・招待・権限など、プロジェクトに属さない操作）に効く方針。
// is_tenant_default = 1 の未削除の方針。無ければ NO_POLICY
export async function tenantDefaultPolicy(env, ctx) {
  if (!complianceOn(env)) return NO_POLICY;
  const row = await env.DB.prepare(
    `SELECT * FROM compliance_policies
      WHERE tenant_id = ? AND is_tenant_default = 1 AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1`
  ).bind(ctx.tenantId).first();
  return row ?? NO_POLICY;
}

// 理由（reason または理由コード）の入力が必須になる操作。
// 「データの変更および削除」のうち取り消し系・削除系・権限系に絞る
// （下書きの自動保存・作成系は理由を要求しない。実務のレビュー対象に合わせた線引き）
const REASON_ACTIONS = new Set([
  'page.reopen',
  'page.delete',
  'notebook.delete',
  'attachment.delete',
  'member.role_change',
  'member.remove',
]);

// その方針の下でその操作に理由が必須か。方針の require_reason が立っていて、
// かつ操作が理由を要求する一覧に含まれるときだけ true。
// （この関数は「要求するか」の判定だけ。各APIへの差し込みは別の指示書）
export function requiresReason(policy, action) {
  return Boolean(policy?.require_reason) && REASON_ACTIONS.has(action);
}
