// メンバー管理画面（オーナーだけがメニューから開ける）。
// 招待メールは送らない設計なので、招待を作ったら「相手への案内文」をここでコピーしてもらう。
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Member, type Role } from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { useApp } from '../state/AppContext.tsx';
import { t } from '../i18n.ts';

type Dialog =
  | { kind: 'invite' }
  | { kind: 'revoke'; member: Member }
  | { kind: 'remove'; member: Member }
  | null;

// 権限の表示名。サーバから来る値は owner / editor / viewer の3つだけ
function roleLabel(role: string): string {
  if (role === 'owner') return t('role.owner');
  if (role === 'viewer') return t('role.viewer');
  return t('role.editor');
}

export function MembersScreen({ onBack }: { onBack: () => void }) {
  const { reportError, notify } = useApp();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState<{ email: string; role: 'editor' | 'viewer' }>(
    { email: '', role: 'editor' }
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 案内文はこの画面で組む（サーバは招待リンクを発行しない）
  const guide = t('members.guideBody', { url: window.location.origin });

  const load = useCallback(async () => {
    try {
      setMembers(await api.listMembers());
    } catch (e) {
      reportError(e);
      setMembers([]);
    }
  }, [reportError]);

  useEffect(() => { void load(); }, [load]);

  const closeDialog = () => { setDialog(null); setFormError(null); };

  // サーバの409/400は、原因が分かる日本語にしてフォームの中に出す
  const showApiError = (e: unknown): void => {
    if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
      setFormError(
        e.code === 'invalid_email' ? t('members.invalidEmail')
          : e.code === 'owner_immutable' ? t('members.ownerImmutable')
            : t('members.alreadyMember')
      );
      return;
    }
    reportError(e);
    closeDialog();
  };

  const submit = async () => {
    if (!dialog) return;
    try {
      if (dialog.kind === 'invite') {
        await api.createInvitation({ email: form.email, role: form.role });
        notify(t('members.invited'));
      } else if (dialog.kind === 'revoke') {
        await api.revokeInvitation(dialog.member.id);
      } else {
        await api.removeMember(dialog.member.id);
      }
      await load();
      closeDialog();
    } catch (e) {
      showApiError(e);
    }
  };

  const changeRole = async (member: Member, role: Role) => {
    try {
      await api.patchMember(member.id, { role });
      await load();
    } catch (e) {
      reportError(e);
    }
  };

  const copyGuide = () => {
    void navigator.clipboard?.writeText(guide).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* クリップボードが使えない環境では、文面を選択してコピーしてもらう */ });
  };

  return (
    <main className="layout single">
      <div className="editor-bar">
        <button type="button" className="link-btn" onClick={onBack}>{t('common.back')}</button>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>{t('members.heading')}</h2>
          <button type="button" className="btn btn-primary btn-small"
            onClick={() => { setForm({ email: '', role: 'editor' }); setFormError(null); setDialog({ kind: 'invite' }); }}>
            {t('members.invite')}
          </button>
        </div>

        {members === null ? (
          <p className="empty-line">{t('common.loading')}</p>
        ) : members.length <= 1 ? (
          <p className="empty-line">{t('members.empty')}</p>
        ) : null}

        {members !== null && members.length > 0 && (
          // スマホ幅では1行＝1カードに畳む（data-labelが消えたヘッダの代わりになる）
          <div className="table-scroll">
            <table className="page-table">
              <thead>
                <tr>
                  <th>{t('members.colEmail')}</th>
                  <th className="col-status">{t('members.colRole')}</th>
                  <th className="col-status">{t('members.colStatus')}</th>
                  <th className="col-actions" aria-label={t('members.colActions')} />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={`${m.kind}-${m.id}`}>
                    <td className="col-main">
                      {m.email}
                      {m.is_self && <span className="member-self">{t('members.you')}</span>}
                      {m.is_primary_owner && <span className="member-self">{t('members.primaryOwner')}</span>}
                    </td>
                    <td className="col-status" data-label={t('members.colRole')}>
                      {/* 設置者の行・自分の行・招待中の行は、その場でのロール変更をさせない。
                          それ以外はオーナーへの引き上げも降格もここでできる */}
                      {m.kind === 'member' && !m.is_primary_owner && !m.is_self ? (
                        <select
                          value={m.role}
                          aria-label={t('members.colRole')}
                          onChange={(e) => { void changeRole(m, e.target.value as Role); }}
                        >
                          <option value="owner">{t('role.owner')}</option>
                          <option value="editor">{t('role.editor')}</option>
                          <option value="viewer">{t('role.viewer')}</option>
                        </select>
                      ) : roleLabel(m.role)}
                    </td>
                    <td className="col-status" data-label={t('members.colStatus')}>
                      <span className={`badge badge-${m.status === 'active' ? 'closed' : 'draft'}`}>
                        {m.status === 'active' ? t('members.statusActive') : t('members.statusPending')}
                      </span>
                    </td>
                    <td className="col-actions">
                      {m.kind === 'invitation' ? (
                        <button type="button" className="link-btn link-danger"
                          onClick={() => setDialog({ kind: 'revoke', member: m })}>
                          {t('members.revoke')}
                        </button>
                      ) : !m.is_primary_owner && !m.is_self ? (
                        <button type="button" className="link-btn link-danger"
                          onClick={() => setDialog({ kind: 'remove', member: m })}>
                          {t('members.remove')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>{t('members.guideHeading')}</h2>
        <p className="invite-guide">{guide}</p>
        <button type="button" className="btn btn-small" onClick={copyGuide}>
          {copied ? t('members.guideCopied') : t('members.guideCopy')}
        </button>
      </section>

      <Modal
        open={dialog !== null}
        title={
          dialog?.kind === 'invite' ? t('members.inviteTitle')
            : dialog?.kind === 'revoke' ? t('members.revokeTitle')
              : t('members.removeTitle')
        }
        onClose={closeDialog}
        onSubmit={submit}
        submitDanger={dialog?.kind === 'revoke' || dialog?.kind === 'remove'}
        submitLabel={
          dialog?.kind === 'invite' ? t('common.create')
            : dialog?.kind === 'revoke' ? t('members.revoke') : t('members.remove')
        }
      >
        {dialog?.kind === 'invite' && (
          <>
            <label className="field">
              <span>{t('members.emailLabel')}</span>
              <input autoFocus type="email" value={form.email} placeholder={t('members.emailPlaceholder')}
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('members.roleLabel')}</span>
              <select value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as 'editor' | 'viewer' })}>
                <option value="editor">{t('role.editor')}</option>
                <option value="viewer">{t('role.viewer')}</option>
              </select>
            </label>
            {/* 招待でオーナーは渡せない。参加してもらってから一覧で引き上げる */}
            <p className="hint">{t('members.ownerHint')}</p>
            <p className="hint">{guide}</p>
          </>
        )}
        {dialog?.kind === 'revoke' && <p>{t('members.revokeConfirm', { email: dialog.member.email })}</p>}
        {dialog?.kind === 'remove' && <p>{t('members.removeConfirm', { email: dialog.member.email })}</p>}
        {formError && <p className="alert">{formError}</p>}
      </Modal>
    </main>
  );
}
