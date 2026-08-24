// プロジェクト管理画面（オーナーだけがメニューから開ける）。
// 左にプロジェクトの一覧、右に「そのプロジェクトを閲覧できる人」のチェックボックス。
//
// 閲覧できる人は差分ではなく一括で送る（サーバも一括置換）。
// 差分にすると「外したつもりが残っていた」が起きるが、置換なら画面の見た目がそのまま正になる。
import { useCallback, useEffect, useState } from 'react';
import { api, type Member, type Project, type ProjectMember } from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { useApp } from '../state/AppContext.tsx';
import { t } from '../i18n.ts';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; project: Project }
  | { kind: 'delete'; project: Project }
  | null;

export function ProjectsScreen({ onBack }: { onBack: () => void }) {
  const { reportError, notify } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // チェックできる相手＝参加済みの editor / viewer。
  // オーナーはチェックしなくても全部見えるので、そもそも並べない
  const [candidates, setCandidates] = useState<Member[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState({ name: '', description: '' });
  const [formError, setFormError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      setSelectedId((current) => (current && list.some((p) => p.id === current) ? current : list[0]?.id ?? null));
    } catch (e) {
      reportError(e);
      setProjects([]);
    }
  }, [reportError]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  useEffect(() => {
    api.listMembers()
      .then((list) => setCandidates(
        list.filter((m) => m.kind === 'member' && m.role !== 'owner')
      ))
      .catch(reportError);
  }, [reportError]);

  // 選んだプロジェクトの「閲覧できる人」を読み直す
  useEffect(() => {
    if (!selectedId) { setChecked(new Set()); return; }
    let alive = true;
    api.getProject(selectedId)
      .then(({ members }: { members: ProjectMember[] }) => {
        if (alive) setChecked(new Set(members.map((m) => m.user_id)));
      })
      .catch((e) => { if (alive) reportError(e); });
    return () => { alive = false; };
  }, [selectedId, reportError]);

  const toggle = (userId: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const saveMembers = async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      await api.setProjectMembers(selectedId, [...checked]);
      notify(t('project.membersSaved'));
    } catch (e) {
      reportError(e);
    } finally {
      setSaving(false);
    }
  };

  const closeDialog = () => { setDialog(null); setFormError(null); };

  const openDialog = (next: Dialog) => {
    setFormError(null);
    setForm(next?.kind === 'edit'
      ? { name: next.project.name, description: next.project.description ?? '' }
      : { name: '', description: '' });
    setDialog(next);
  };

  const submit = async () => {
    if (!dialog) return;
    try {
      if (dialog.kind === 'delete') {
        await api.deleteProject(dialog.project.id);
        if (selectedId === dialog.project.id) setSelectedId(null);
      } else {
        if (!form.name.trim()) { setFormError(t('project.nameRequired')); return; }
        if (dialog.kind === 'create') {
          const created = await api.createProject({ name: form.name, description: form.description });
          setSelectedId(created.id);
        } else {
          await api.patchProject(dialog.project.id, { name: form.name, description: form.description });
        }
      }
      await loadProjects();
      closeDialog();
    } catch (e) {
      reportError(e);
      closeDialog();
    }
  };

  const selected = projects?.find((p) => p.id === selectedId) ?? null;

  return (
    <main className="layout">
      <div className="editor-bar">
        <button type="button" className="link-btn" onClick={onBack}>{t('common.back')}</button>
      </div>

      <section className="panel notebooks-panel">
        <div className="panel-head">
          <h2>{t('project.heading')}</h2>
          <button type="button" className="btn btn-primary btn-small"
            onClick={() => openDialog({ kind: 'create' })}>
            {t('project.new')}
          </button>
        </div>
        <p className="hint">{t('project.lead')}</p>

        {projects === null ? (
          <p className="empty-line">{t('common.loading')}</p>
        ) : projects.length === 0 ? (
          <p className="empty-line">{t('project.empty')}</p>
        ) : (
          <ul className="notebook-list">
            {projects.map((p) => (
              <li key={p.id}>
                <div className={`notebook-card${p.id === selectedId ? ' selected' : ''}`}>
                  <button type="button" className="notebook-open" onClick={() => setSelectedId(p.id)}>
                    <span className="notebook-title">{p.name}</span>
                    <span className="notebook-desc">{p.description || t('notebook.noDescription')}</span>
                    <span className="notebook-meta">
                      {t('project.notebookCount', { count: p.notebook_count ?? 0 })}
                    </span>
                  </button>
                  <div className="notebook-actions">
                    <button type="button" className="link-btn"
                      onClick={() => openDialog({ kind: 'edit', project: p })}>
                      {t('common.rename')}
                    </button>
                    <button type="button" className="link-btn link-danger"
                      onClick={() => openDialog({ kind: 'delete', project: p })}>
                      {t('common.delete')}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel pages-panel">
        {selected === null ? (
          <p className="empty-line">{t('project.selectPrompt')}</p>
        ) : (
          <>
            <div className="panel-head">
              <h2>{t('project.membersHeading')}</h2>
              <button type="button" className="btn btn-primary btn-small"
                disabled={saving} onClick={() => { void saveMembers(); }}>
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
            <p className="hint">{t('project.membersHint')}</p>
            {candidates.length === 0 ? (
              <p className="empty-line">{t('project.membersEmpty')}</p>
            ) : (
              <ul className="member-check-list">
                {candidates.map((m) => (
                  <li key={m.id}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={checked.has(m.id)}
                        onChange={() => toggle(m.id)}
                      />
                      <span>{m.email}</span>
                      <span className="badge">
                        {m.role === 'viewer' ? t('role.viewer') : t('role.editor')}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <Modal
        open={dialog !== null}
        title={
          dialog?.kind === 'create' ? t('project.createTitle')
            : dialog?.kind === 'edit' ? t('project.renameTitle')
              : t('project.deleteTitle')
        }
        onClose={closeDialog}
        onSubmit={submit}
        submitDanger={dialog?.kind === 'delete'}
        submitLabel={
          dialog?.kind === 'delete' ? t('common.delete')
            : dialog?.kind === 'edit' ? t('common.save') : t('common.create')
        }
      >
        {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
          <>
            <label className="field">
              <span>{t('project.nameLabel')}</span>
              <input autoFocus value={form.name} placeholder={t('project.namePlaceholder')}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('project.descriptionLabel')}</span>
              <input value={form.description} placeholder={t('project.descriptionPlaceholder')}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
          </>
        )}
        {dialog?.kind === 'delete' && <p>{t('project.deleteConfirm', { name: dialog.project.name })}</p>}
        {formError && <p className="alert">{formError}</p>}
      </Modal>
    </main>
  );
}
