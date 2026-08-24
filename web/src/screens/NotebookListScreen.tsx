// ノート一覧画面。
// 左（狭い画面では上）にノートブックのカード、右に選んだノートブックのページ一覧を出す。
import { useCallback, useEffect, useState } from 'react';
import { api, type Notebook, type PageSummary, type Project, type SearchResponse } from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { useApp } from '../state/AppContext.tsx';
import { t } from '../i18n.ts';

// 日付の表示。ISO文字列（2026-07-01T12:34:56.000Z）を「2026/07/01 21:34」に
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// モーダルの用途。1つのモーダルを使い回す
type Dialog =
  | { kind: 'createNotebook' }
  | { kind: 'renameNotebook'; notebook: Notebook }
  | { kind: 'deleteNotebook'; notebook: Notebook }
  | { kind: 'createPage' }
  | { kind: 'deletePage'; page: PageSummary }
  | null;

export function NotebookListScreen({ onOpenPage }: { onOpenPage: (pageId: string) => void }) {
  // canEdit=false（閲覧専用）のときは、書き込みの入口をそもそも出さない。
  // サーバも403で断るが、押せるボタンを出しておいて怒られるのは道具として不親切
  const { reportError, canEdit, isOwner, isDemo } = useApp();
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  // 自分に見えるプロジェクト。ノートブックの札と、作成／編集モーダルの選択肢に使う
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  // スマホ幅では2カラムが1カラムに畳まれるので、どちらの列を見せているかを持つ。
  // 広い画面ではCSSがこの札を無視して両方出す（＝この状態は画面の見た目に効かない）
  const [pane, setPane] = useState<'notebooks' | 'pages'>('notebooks');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState({ title: '', description: '', date: '', projectId: '' });
  const [formError, setFormError] = useState<string | null>(null);

  // 検索。打つたびに叩かず、Enter（またはボタン）で確定してから1回だけ問い合わせる。
  // search が null のときは通常のノート一覧、非nullなら検索結果に画面を差し替える。
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  const runSearch = async () => {
    const q = searchInput.trim();
    if (!q) { setSearch(null); return; }
    setSearching(true);
    try {
      setSearch(await api.search(q));
    } catch (e) {
      reportError(e);
      setSearch(null);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => { setSearchInput(''); setSearch(null); };

  const loadNotebooks = useCallback(async () => {
    try {
      const list = await api.listNotebooks();
      setNotebooks(list);
      // 何も選んでいなければ先頭を開く
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    } catch (e) {
      reportError(e);
      setNotebooks([]);
    }
  }, [reportError]);

  useEffect(() => { void loadNotebooks(); }, [loadNotebooks]);

  // プロジェクトが1つも無ければ選択欄自体を出さない（使わない人には見えないままにする）
  useEffect(() => {
    api.listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (!selectedId) { setPages(null); return; }
    let alive = true;
    setPages(null);
    api.listPages(selectedId)
      .then((list) => { if (alive) setPages(list); })
      .catch((e) => { if (alive) { reportError(e); setPages([]); } });
    return () => { alive = false; };
  }, [selectedId, reportError]);

  const closeDialog = () => { setDialog(null); setFormError(null); };

  const openDialog = (next: Dialog) => {
    setFormError(null);
    if (next?.kind === 'renameNotebook') {
      setForm({
        title: next.notebook.title,
        description: next.notebook.description ?? '',
        date: '',
        projectId: next.notebook.project_id ?? '',
      });
    } else if (next?.kind === 'createPage') {
      // 実験日の既定は今日。ほとんどの場合そのままで正しい
      setForm({
        title: '', description: '', date: new Date().toISOString().slice(0, 10), projectId: '',
      });
    } else {
      setForm({ title: '', description: '', date: '', projectId: '' });
    }
    setDialog(next);
  };

  const submit = async () => {
    if (!dialog) return;
    try {
      switch (dialog.kind) {
        case 'createNotebook': {
          if (!form.title.trim()) { setFormError(t('notebook.titleRequired')); return; }
          const created = await api.createNotebook({
            title: form.title, description: form.description, project_id: form.projectId,
          });
          await loadNotebooks();
          setSelectedId(created.id);
          // 作ったらそのまま中身（ページ一覧）へ入る
          setPane('pages');
          break;
        }
        case 'renameNotebook': {
          if (!form.title.trim()) { setFormError(t('notebook.titleRequired')); return; }
          await api.patchNotebook(dialog.notebook.id, {
            title: form.title, description: form.description, project_id: form.projectId,
          });
          // プロジェクトを付け替えた結果、自分から見えなくなることもある。
          // 戻り値ではなく一覧を引き直して、画面をサーバの言うとおりにする
          await loadNotebooks();
          break;
        }
        case 'deleteNotebook': {
          await api.deleteNotebook(dialog.notebook.id);
          if (selectedId === dialog.notebook.id) { setSelectedId(null); setPane('notebooks'); }
          await loadNotebooks();
          break;
        }
        case 'createPage': {
          if (!selectedId) return;
          if (!form.title.trim()) { setFormError(t('page.titleRequired')); return; }
          const page = await api.createPage(selectedId, { title: form.title, experiment_date: form.date });
          closeDialog();
          onOpenPage(page.id);
          return;
        }
        case 'deletePage': {
          await api.deletePage(dialog.page.id);
          setPages((current) => (current ?? []).filter((p) => p.id !== dialog.page.id));
          break;
        }
      }
      closeDialog();
    } catch (e) {
      reportError(e);
      closeDialog();
    }
  };

  const selected = notebooks?.find((n) => n.id === selectedId) ?? null;

  // ノートブックの札に出すプロジェクト名。消されたプロジェクトを指していても画面は壊さない
  const projectNameOf = (id: string | null): string | null =>
    (id ? projects.find((p) => p.id === id)?.name ?? t('project.restricted') : null);

  return (
    <main className="layout">
      <section className="panel search-panel">
        <form
          className="search-form"
          onSubmit={(e) => { e.preventDefault(); void runSearch(); }}
        >
          <input
            type="search"
            className="search-input"
            value={searchInput}
            aria-label={t('search.label')}
            placeholder={t('search.placeholder')}
            onChange={(e) => {
              setSearchInput(e.target.value);
              // 入力欄を空にしたら通常の一覧へ戻す（×ボタンを押したときの自然な挙動）
              if (!e.target.value.trim()) setSearch(null);
            }}
          />
          <button type="submit" className="btn btn-primary btn-small" disabled={searching}>
            {searching ? t('search.searching') : t('search.run')}
          </button>
          {search && (
            <button type="button" className="link-btn" onClick={clearSearch}>
              {t('search.clear')}
            </button>
          )}
        </form>
        <p className="hint">{t('search.hint')}</p>
      </section>

      {!canEdit && (
        <p className="locked-notice">{isDemo ? t('role.demoNotice') : t('role.viewerNotice')}</p>
      )}

      {search ? (
        <section className="panel search-results">
          <div className="panel-head">
            <h2>{t('search.resultsTitle', { query: search.query, count: search.results.length })}</h2>
            {search.mode === 'like' && <span className="badge">{t('search.likeMode')}</span>}
          </div>
          {search.results.length === 0 ? (
            <p className="empty-line">{t('search.noResults')}</p>
          ) : (
            <ul className="search-list">
              {search.results.map((hit) => (
                <li key={hit.pageId}>
                  <button type="button" className="search-hit" onClick={() => onOpenPage(hit.pageId)}>
                    <span className="search-hit-title">{hit.pageTitle}</span>
                    <span className="search-hit-meta">
                      {hit.notebookTitle} ・ {t('page.updatedAt')} {formatDateTime(hit.updatedAt)}
                    </span>
                    {hit.snippet && <span className="search-hit-snippet">{hit.snippet}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
      {/* スマホ幅では pane-hidden が付いた方の列を隠して1カラムにする（960px以上では両方出る） */}
      <section className={`panel notebooks-panel${pane === 'pages' ? ' pane-hidden' : ''}`}>
        <div className="panel-head">
          <h2>{t('notebook.heading')}</h2>
          {canEdit && (
            <button type="button" className="btn btn-primary btn-small"
              onClick={() => openDialog({ kind: 'createNotebook' })}>
              {t('notebook.new')}
            </button>
          )}
        </div>
        {notebooks === null ? (
          <p className="empty-line">{t('common.loading')}</p>
        ) : notebooks.length === 0 ? (
          <p className="empty-line">{t('notebook.empty')}</p>
        ) : (
          <ul className="notebook-list">
            {notebooks.map((nb) => (
              <li key={nb.id}>
                <div className={`notebook-card${nb.id === selectedId ? ' selected' : ''}`}>
                  <button
                    type="button"
                    className="notebook-open"
                    onClick={() => { setSelectedId(nb.id); setPane('pages'); }}
                  >
                    <span className="notebook-title">{nb.title}</span>
                    {/* プロジェクトに入っているノートブックは、見える範囲が絞られていることを札で示す */}
                    {projectNameOf(nb.project_id) && (
                      <span className="badge badge-project">{projectNameOf(nb.project_id)}</span>
                    )}
                    <span className="notebook-desc">{nb.description || t('notebook.noDescription')}</span>
                    <span className="notebook-meta">{t('page.updatedAt')} {formatDateTime(nb.updated_at)}</span>
                  </button>
                  {canEdit && (
                    <div className="notebook-actions">
                      <button type="button" className="link-btn"
                        onClick={() => openDialog({ kind: 'renameNotebook', notebook: nb })}>
                        {t('common.rename')}
                      </button>
                      <button type="button" className="link-btn link-danger"
                        onClick={() => openDialog({ kind: 'deleteNotebook', notebook: nb })}>
                        {t('common.delete')}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`panel pages-panel${pane === 'notebooks' ? ' pane-hidden' : ''}`}>
        {/* 戻る導線はスマホ幅だけ。広い画面は左にノートブック一覧が出たままなので要らない */}
        <button type="button" className="link-btn mobile-only" onClick={() => setPane('notebooks')}>
          {t('notebook.backToList')}
        </button>
        <div className="panel-head">
          <h2>{selected ? selected.title : t('page.heading')}</h2>
          {canEdit && (
            <button type="button" className="btn btn-primary btn-small"
              disabled={!selected}
              onClick={() => openDialog({ kind: 'createPage' })}>
              {t('page.new')}
            </button>
          )}
        </div>
        {!selected ? (
          <p className="empty-line">{t('notebook.selectPrompt')}</p>
        ) : pages === null ? (
          <p className="empty-line">{t('common.loading')}</p>
        ) : pages.length === 0 ? (
          <p className="empty-line">{t('page.empty')}</p>
        ) : (
          // 狭い画面では横スクロール、スマホ幅では1行＝1カードに畳む（data-labelが見出しになる）
          <div className="table-scroll">
            <table className="page-table">
              <thead>
                <tr>
                  <th>{t('page.titleLabel')}</th>
                  <th className="col-date">{t('page.experimentDate')}</th>
                  <th className="col-status">{t('status.draft')}／{t('status.closed')}</th>
                  <th className="col-date">{t('page.updatedAt')}</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {pages.map((page) => (
                  <tr key={page.id}>
                    <td className="col-main">
                      <button type="button" className="link-btn strong" onClick={() => onOpenPage(page.id)}>
                        {page.title}
                      </button>
                    </td>
                    <td className="col-date" data-label={t('page.experimentDate')}>
                      {page.experiment_date || '—'}
                    </td>
                    <td className="col-status" data-label={t('common.status')}>
                      <span className={`badge badge-${page.status}`}>{t(`status.${page.status}`)}</span>
                    </td>
                    <td className="col-date" data-label={t('page.updatedAt')}>{formatDateTime(page.updated_at)}</td>
                    <td className="col-actions">
                      {canEdit && (
                        <button type="button" className="link-btn link-danger"
                          onClick={() => openDialog({ kind: 'deletePage', page })}>
                          {t('common.delete')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
        </>
      )}

      <Modal
        open={dialog !== null}
        title={
          dialog?.kind === 'createNotebook' ? t('notebook.createTitle')
            : dialog?.kind === 'renameNotebook' ? t('notebook.renameTitle')
              : dialog?.kind === 'createPage' ? t('page.createTitle')
                : t('common.delete')
        }
        onClose={closeDialog}
        onSubmit={submit}
        submitDanger={dialog?.kind === 'deleteNotebook' || dialog?.kind === 'deletePage'}
        submitLabel={
          dialog?.kind === 'deleteNotebook' || dialog?.kind === 'deletePage'
            ? t('common.delete')
            : dialog?.kind === 'renameNotebook' ? t('common.save') : t('common.create')
        }
      >
        {(dialog?.kind === 'createNotebook' || dialog?.kind === 'renameNotebook') && (
          <>
            <label className="field">
              <span>{t('notebook.titleLabel')}</span>
              <input autoFocus value={form.title} placeholder={t('notebook.titlePlaceholder')}
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('notebook.descriptionLabel')}</span>
              <input value={form.description} placeholder={t('notebook.descriptionPlaceholder')}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            {/* プロジェクトの割り当てはオーナーだけ。誰が見られるかを決める操作なので、
                作った本人が自由に絞れる形にはしない。プロジェクトが無いときは欄ごと出さない */}
            {isOwner && projects.length > 0 && (
              <label className="field">
                <span>{t('project.notebookLabel')}</span>
                <select value={form.projectId}
                  onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                  <option value="">{t('project.noneHint')}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        {dialog?.kind === 'createPage' && (
          <>
            <label className="field">
              <span>{t('page.titleLabel')}</span>
              <input autoFocus value={form.title} placeholder={t('page.titlePlaceholder')}
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('page.experimentDate')}</span>
              <input type="date" value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </label>
          </>
        )}
        {dialog?.kind === 'deleteNotebook' && (
          <p>{t('notebook.deleteConfirm', { title: dialog.notebook.title })}</p>
        )}
        {dialog?.kind === 'deletePage' && (
          <p>{t('page.deleteConfirm', { title: dialog.page.title })}</p>
        )}
        {formError && <p className="alert">{formError}</p>}
      </Modal>
    </main>
  );
}
