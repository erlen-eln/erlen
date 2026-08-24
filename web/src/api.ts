// バックエンド（Worker）との通信をここ1本にまとめる。
// 画面のどこからも fetch を直接書かないこと。401（未ログイン）の扱いを1か所で決めたいため。
import type { Molecule } from './calc/types.ts';
import { getLocale } from './i18n.ts';

// テナント全体で1人1つのロール。
//   owner  … 全操作＋メンバー管理＋プロジェクト設定。何人でも置ける。
//             設置者（vars.OWNER_EMAIL 本人＝主オーナー）だけは降格も除名もできない
//   editor … ノート・ページ・添付の全CRUD（研究室の記録を書く人）
//   viewer … 閲覧のみ（書き込み系APIはサーバが403で断る）
export type Role = 'owner' | 'editor' | 'viewer';

export interface Me {
  email: string;
  name: string;
  role: Role;
  // 公開デモ（DEMO_MODE="1"）で入った閲覧者。role は viewer 固定で、users行を持たない
  demo?: boolean;
}

// /api/health（ログイン不要）。ログイン画面が「ここはデモ機か」を知る唯一の手段
export interface Health {
  ok: true;
  version: string;
  demo: boolean;
}

// メンバー一覧の1行。参加済み（member/active）と未受諾の招待（invitation/pending）が混ざる
export interface Member {
  kind: 'member' | 'invitation';
  id: string;
  email: string;
  name: string;
  role: string;
  status: 'active' | 'pending';
  created_at: string;
  is_self: boolean;
  // 設置者（vars.OWNER_EMAIL 本人）。この行は権限セレクトも除名ボタンも出さない
  is_primary_owner: boolean;
  owner_granted_at: string | null;
}

// プロジェクト。ノートブックを束ね、閲覧できる人を絞るための単位。
// プロジェクトに入れていないノートブックは、これまでどおりテナント全員が見られる
export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  // 一覧のときだけ付く（単体取得では返らない）
  notebook_count?: number;
}

// プロジェクトを閲覧できる人。オーナーは登録しなくても全部見えるので、ここには現れない
export interface ProjectMember {
  user_id: string;
  email: string;
  name: string;
  role: string;
}

export interface Notebook {
  id: string;
  title: string;
  description: string;
  // 所属プロジェクト。null は「プロジェクトなし＝全員が見られる」
  project_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PageSummary {
  id: string;
  notebook_id: string;
  title: string;
  status: 'draft' | 'closed';
  experiment_date: string;
  created_at: string;
  updated_at: string;
}

export interface Page extends PageSummary {
  user_id: string;
  content: string;
}

export interface Attachment {
  id: string;
  page_id: string;
  user_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  sha256: string;
  created_at: string;
}

// 検索結果はサーバが表示用に整えた形で返る（本文をまるごと送らないため）
export interface SearchHit {
  pageId: string;
  notebookId: string;
  notebookTitle: string;
  pageTitle: string;
  snippet: string;
  updatedAt: string;
}

export interface SearchResponse {
  query: string;
  // fts=trigram索引での検索 / like=3文字未満なので総なめの簡易検索
  mode: 'fts' | 'like';
  results: SearchHit[];
}

// ---- 台帳3種（試薬マスタ・試薬在庫・機器） ----

// 試薬マスタ。研究室で使う試薬の「定義」。反応テーブルへ引き写す元になる
export interface ReagentMaster {
  id: string;
  name: string;
  cas_number: string;
  molecular_weight: number | null;
  purity: number | null;
  density: number | null;
  smiles: string;
  molfile: string;
  svg: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export type ReagentInput = Partial<Omit<ReagentMaster, 'id' | 'created_at' | 'updated_at'>>;

// 試薬在庫。棚にある現物のボトル1本。
// display_name より下はサーバがマスタをJOINして付けてくる表示用の値（DBの列ではない）
export interface ReagentStock {
  id: string;
  reagent_master_id: string | null;
  custom_reagent_name: string;
  manufacturer: string;
  lot_number: string;
  received_date: string;
  is_opened: number;
  storage_location: string;
  remaining_amount: number | null;
  remaining_unit: string;
  notes: string;
  created_at: string;
  updated_at: string;
  display_name: string;
  master_name: string | null;
  cas_number: string | null;
  // マスタのSMILES。画面はここからRDKitで構造式サムネを描く（SVGは重いので一覧には載せない）
  smiles: string | null;
  molecular_weight: number | null;
  density: number | null;
  purity: number | null;
}

export interface StockInput {
  reagent_master_id?: string | null;
  custom_reagent_name?: string;
  manufacturer?: string;
  lot_number?: string;
  received_date?: string;
  is_opened?: boolean;
  storage_location?: string;
  remaining_amount?: number | null;
  remaining_unit?: string;
  notes?: string;
}

export interface Equipment {
  id: string;
  name: string;
  category: string;
  capacity: string;
  temperature_range: string;
  pressure_range: string;
  manufacturer: string;
  model_number: string;
  management_number: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export type EquipmentInput = Partial<Omit<Equipment, 'id' | 'created_at' | 'updated_at'>>;

// 同梱プリセット（public/presets/*.json）の形
export interface Preset<T> {
  meta: { name: string; description: string; count: number; source: string; caution: string };
  items: T[];
}

export interface PubChemCompound {
  cid: number;
  name: string | null;
  molecular_weight: number | null;
  cas_number: string | null;
  smiles: string | null;
  formula: string | null;
  inchi: string | null;
  exact_mass: string | null;
  xlogp: number | null;
}

// サーバが返すエラーを status 付きで運ぶ。401なら画面はログイン画面へ切り替える
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
      // セッションCookieは同一オリジンなので既定のままでよいが、意図を明示しておく
      credentials: 'same-origin',
    });
  } catch {
    // オフライン・DNS失敗など。statusが無いので0で表す
    throw new ApiError(0, 'network_error');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, String((body as { error?: string }).error ?? 'error'));
  return body as T;
}

// DBの molecules 行（is_reference が 0/1、未入力がnull）を画面の型へ。
// 0/1のまま扱うとチェックボックスの制御でバグるので、入口で真偽値に直す
function toMolecule(row: Record<string, unknown>, index: number): Molecule {
  const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    id: String(row.id),
    role: row.role === 'product' ? 'product' : 'reactant',
    name: String(row.name ?? ''),
    smiles: String(row.smiles ?? ''),
    molfile: String(row.molfile ?? ''),
    svg: String(row.svg ?? ''),
    cas_number: String(row.cas_number ?? ''),
    molecular_weight: num(row.molecular_weight),
    density: num(row.density),
    purity: num(row.purity),
    equivalents: num(row.equivalents),
    mass: num(row.mass),
    moles: num(row.moles),
    volume: num(row.volume),
    molarity: num(row.molarity),
    is_reference: Boolean(row.is_reference),
    yield_percent: num(row.yield_percent),
    sort_order: num(row.sort_order) ?? index,
  };
}

export const api = {
  me: () => request<Me>('/api/me'),

  health: () => request<Health>('/api/health'),

  listNotebooks: () => request<{ notebooks: Notebook[] }>('/api/notebooks').then((r) => r.notebooks),

  createNotebook: (body: { title: string; description?: string; project_id?: string | null }) =>
    request<{ notebook: Notebook }>('/api/notebooks', {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.notebook),

  // project_id に '' を渡すと「プロジェクトなし」へ戻す。
  // プロジェクトを付け替えた結果、自分から見えなくなることがある（オーナー以外）。
  // そのときサーバは notebook を返せないので、呼び出し側は戻り値を当てにせず一覧を引き直す
  patchNotebook: (id: string, body: {
    title?: string; description?: string; project_id?: string | null;
  }) =>
    request<{ notebook?: Notebook }>(`/api/notebooks/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }).then((r) => r.notebook ?? null),

  deleteNotebook: (id: string) => request<{ ok: true }>(`/api/notebooks/${id}`, { method: 'DELETE' }),

  listPages: (notebookId: string) =>
    request<{ pages: PageSummary[] }>(`/api/notebooks/${notebookId}/pages`).then((r) => r.pages),

  createPage: (notebookId: string, body: { title: string; experiment_date?: string }) =>
    request<{ page: Page }>(`/api/notebooks/${notebookId}/pages`, {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.page),

  getPage: (id: string) =>
    request<{ page: Page; molecules: Record<string, unknown>[] }>(`/api/pages/${id}`)
      .then((r) => ({ page: r.page, molecules: r.molecules.map(toMolecule) })),

  patchPage: (id: string, body: Partial<Pick<Page, 'title' | 'content' | 'status' | 'experiment_date'>>) =>
    request<{ page: Page; molecules: Record<string, unknown>[] }>(`/api/pages/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }).then((r) => r.page),

  deletePage: (id: string) => request<{ ok: true }>(`/api/pages/${id}`, { method: 'DELETE' }),

  // 反応テーブルは行の増減があるので「表まるごと置き換え」で保存する（サーバ側も一括置換）
  saveMolecules: (pageId: string, molecules: Molecule[]) =>
    request<{ molecules: Record<string, unknown>[]; rev_no: number }>(`/api/pages/${pageId}/molecules`, {
      method: 'PUT',
      body: JSON.stringify({
        molecules: molecules.map((m, i) => ({ ...m, is_reference: m.is_reference ? 1 : 0, sort_order: i })),
      }),
    }).then((r) => ({ molecules: r.molecules.map(toMolecule), rev_no: r.rev_no })),

  // ---- 添付ファイル ----
  listAttachments: (pageId: string) =>
    request<{ attachments: Attachment[] }>(`/api/pages/${pageId}/attachments`).then((r) => r.attachments),

  // アップロードだけは fetch ではなく XMLHttpRequest を使う。
  // fetch には「送信の進捗」を知る手段が無く、大きなスペクトルを上げている間、
  // 画面が固まったように見えてしまうため。
  uploadAttachment: (pageId: string, file: File, onProgress?: (ratio: number) => void) =>
    new Promise<Attachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `/api/pages/${pageId}/attachments?filename=${encodeURIComponent(file.name)}`;
      xhr.open('POST', url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body: { attachment?: Attachment; error?: string } = {};
        try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* 空・非JSONは既定値 */ }
        if (xhr.status >= 200 && xhr.status < 300 && body.attachment) resolve(body.attachment);
        else reject(new ApiError(xhr.status, body.error ?? 'error'));
      };
      xhr.onerror = () => reject(new ApiError(0, 'network_error'));
      xhr.onabort = () => reject(new ApiError(0, 'aborted'));
      xhr.send(file);
    }),

  deleteAttachment: (id: string) => request<{ ok: true }>(`/api/attachments/${id}`, { method: 'DELETE' }),

  // ダウンロードと印刷レポートはブラウザにそのまま開かせる（Cookieが付くので追加の細工は要らない）
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
  // レポートは既定が日本語（サーバ側 report.mjs の既定と揃えている）。英語表示中だけ ?lang=en を渡す
  reportUrl: (pageId: string) => `/api/pages/${pageId}/report${getLocale() === 'en' ? '?lang=en' : ''}`,

  // ---- 全文検索 ----
  search: (q: string) => request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`),

  // PubChem照会。見つからない・外部障害でも200で返ってくる（found:false）
  pubchem: (type: 'cas' | 'name' | 'smiles', q: string) =>
    request<{ found: boolean; compound?: PubChemCompound; cached: boolean }>(
      `/api/pubchem?type=${type}&q=${encodeURIComponent(q)}`
    ),

  // ---- 台帳3種。一覧は ?q= で絞り込む（サーバ側のLIKE検索） ----
  listReagents: (q = '') =>
    request<{ reagents: ReagentMaster[] }>(`/api/reagents${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then((r) => r.reagents),

  createReagent: (body: ReagentInput) =>
    request<{ reagent: ReagentMaster }>('/api/reagents', {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.reagent),

  patchReagent: (id: string, body: ReagentInput) =>
    request<{ reagent: ReagentMaster }>(`/api/reagents/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }).then((r) => r.reagent),

  deleteReagent: (id: string) => request<{ ok: true }>(`/api/reagents/${id}`, { method: 'DELETE' }),

  bulkCreateReagents: (items: ReagentInput[]) =>
    request<{ created: number }>('/api/reagents/bulk', {
      method: 'POST', body: JSON.stringify({ items }),
    }),

  listStocks: (q = '') =>
    request<{ stocks: ReagentStock[] }>(`/api/stocks${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then((r) => r.stocks),

  createStock: (body: StockInput) =>
    request<{ stock: ReagentStock }>('/api/stocks', {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.stock),

  patchStock: (id: string, body: StockInput) =>
    request<{ stock: ReagentStock }>(`/api/stocks/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }).then((r) => r.stock),

  deleteStock: (id: string) => request<{ ok: true }>(`/api/stocks/${id}`, { method: 'DELETE' }),

  listEquipments: (q = '') =>
    request<{ equipments: Equipment[] }>(`/api/equipments${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then((r) => r.equipments),

  createEquipment: (body: EquipmentInput) =>
    request<{ equipment: Equipment }>('/api/equipments', {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.equipment),

  patchEquipment: (id: string, body: EquipmentInput) =>
    request<{ equipment: Equipment }>(`/api/equipments/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }).then((r) => r.equipment),

  deleteEquipment: (id: string) => request<{ ok: true }>(`/api/equipments/${id}`, { method: 'DELETE' }),

  bulkCreateEquipments: (items: EquipmentInput[]) =>
    request<{ created: number }>('/api/equipments/bulk', {
      method: 'POST', body: JSON.stringify({ items }),
    }),

  // 同梱プリセットの読み込み。public/presets/ に置いた静的ファイル（APIではない）
  loadPreset: <T>(file: string) => request<Preset<T>>(`/presets/${file}`),

  // ---- プロジェクト（変更系と閲覧可能メンバーの設定はサーバ側でオーナー限定） ----
  // 一覧・単体は「自分に見えるものだけ」が返る。見えないものは404
  listProjects: () => request<{ projects: Project[] }>('/api/projects').then((r) => r.projects),

  getProject: (id: string) =>
    request<{ project: Project; members: ProjectMember[] }>(`/api/projects/${id}`),

  createProject: (body: { name: string; description?: string }) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.project),

  patchProject: (id: string, body: { name?: string; description?: string }) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }).then((r) => r.project),

  deleteProject: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // 閲覧可能メンバーは一括置換。画面のチェック状態をそのまま送る（差分は送らない）
  setProjectMembers: (id: string, userIds: string[]) =>
    request<{ members: ProjectMember[] }>(`/api/projects/${id}/members`, {
      method: 'PUT', body: JSON.stringify({ user_ids: userIds }),
    }).then((r) => r.members),

  // ---- メンバー管理（変更系はサーバ側でオーナー限定） ----
  listMembers: () => request<{ members: Member[] }>('/api/members').then((r) => r.members),

  // 招待でオーナーは渡せない（参加してもらってから patchMember で昇格させる）
  createInvitation: (body: { email: string; role: 'editor' | 'viewer' }) =>
    request<{ invitation: Member }>('/api/invitations', {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.invitation),

  revokeInvitation: (id: string) => request<{ ok: true }>(`/api/invitations/${id}`, { method: 'DELETE' }),

  patchMember: (id: string, body: { role: Role }) =>
    request<{ member: Member }>(`/api/members/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }).then((r) => r.member),

  removeMember: (id: string) => request<{ ok: true }>(`/api/members/${id}`, { method: 'DELETE' }),

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
};
