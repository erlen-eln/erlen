// ページ編集画面。1実験＝1ページ。
// 本文と反応テーブルは別々に自動保存する（本文はPATCH、テーブルはPUTの一括置換）。
// status='closed'（記録の確定）にすると、サーバもここも編集を受け付けなくなる。
import { useCallback, useEffect, useState } from 'react';
import { api, type Page } from '../api.ts';
import type { Molecule } from '../calc/types.ts';
import { AttachmentPanel } from '../components/AttachmentPanel.tsx';
import { ReactionTable } from '../components/ReactionTable.tsx';
import { SaveIndicator } from '../components/SaveIndicator.tsx';
import { Modal } from '../components/Modal.tsx';
import { mergeSaveState, useAutoSave } from '../hooks/useAutoSave.ts';
import { useApp } from '../state/AppContext.tsx';
import { t } from '../i18n.ts';

interface Props {
  pageId: string;
  onBack: () => void;
}

export function PageEditorScreen({ pageId, onBack }: Props) {
  const { reportError, canEdit } = useApp();
  const [page, setPage] = useState<Page | null>(null);
  const [missing, setMissing] = useState(false);
  const [rows, setRows] = useState<Molecule[]>([]);
  const [confirmClose, setConfirmClose] = useState(false);

  // 「利用者が触った回数」。自動保存はこの数が進んだときだけ走る（読み込み直後は走らない）
  const [pageRev, setPageRev] = useState(0);
  const [molRev, setMolRev] = useState(0);

  // 「確定済みのページ」と「閲覧専用の人」を同じ readOnly で扱う。
  // ここがtrueなら自動保存も走らない（useAutoSaveのenabledに渡している）
  const readOnly = page?.status === 'closed' || !canEdit;

  useEffect(() => {
    let alive = true;
    setPage(null);
    setMissing(false);
    api.getPage(pageId)
      .then(({ page: loaded, molecules }) => {
        if (!alive) return;
        setPage(loaded);
        setRows(molecules);
      })
      .catch((e) => {
        if (!alive) return;
        setMissing(true);
        reportError(e);
      });
    return () => { alive = false; };
  }, [pageId, reportError]);

  // 本文・タイトル・実験日の保存。
  // タイトルを消しかけている途中で保存が走ることがあるので、空のときは送らない
  // （サーバは空タイトルを400で弾く。保存済みのタイトルはそのまま残る）
  const savePage = useCallback(async () => {
    if (!page) return;
    const title = page.title.trim();
    await api.patchPage(page.id, {
      ...(title ? { title } : {}),
      content: page.content,
      experiment_date: page.experiment_date,
    });
  }, [page]);

  // 反応テーブルの保存（表まるごと置き換え）。
  // サーバが採番したID（ULID）を手元の行へ引き継ぐ。しないと毎回「知らないID」として
  // INSERTし直され、行のIDが保存のたびに変わってしまう。
  // 保存中に行が増減していたら引き継ぎは諦める（利用者の編集を上書きしない方を優先する）。
  const saveTable = useCallback(async () => {
    if (!page) return;
    const result = await api.saveMolecules(page.id, rows);
    setRows((current) => (
      current.length === result.molecules.length
        ? current.map((row, i) => ({ ...row, id: result.molecules[i].id }))
        : current
    ));
  }, [page, rows]);

  const pageSave = useAutoSave(pageRev, savePage, { enabled: !!page && !readOnly });
  const tableSave = useAutoSave(molRev, saveTable, { enabled: !!page && !readOnly });
  const saveState = mergeSaveState(pageSave.state, tableSave.state);

  // 一覧へ戻るときは、待たずに書き切ってから離れる
  const back = async () => {
    await Promise.all([pageSave.flush(), tableSave.flush()]);
    onBack();
  };

  // タブを閉じる・再読み込みのときに未保存があれば引き止める
  useEffect(() => {
    if (!pageSave.dirty && !tableSave.dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pageSave.dirty, tableSave.dirty]);

  const editPage = (patch: Partial<Page>) => {
    setPage((current) => (current ? { ...current, ...patch } : current));
    setPageRev((n) => n + 1);
  };

  const editRows = (next: Molecule[]) => {
    setRows(next);
    setMolRev((n) => n + 1);
  };

  // 確定・確定取り消しは自動保存に混ぜず、その場で反映する（重い意味を持つ操作なので）
  const changeStatus = async (status: 'draft' | 'closed') => {
    if (!page) return;
    try {
      // 確定前に、書きかけを全部サーバへ送っておく
      await Promise.all([pageSave.flush(), tableSave.flush()]);
      const updated = await api.patchPage(page.id, { status });
      setPage(updated);
    } catch (e) {
      reportError(e);
    } finally {
      setConfirmClose(false);
    }
  };

  if (missing) {
    return (
      <main className="layout single">
        <section className="panel">
          <p className="empty-line">{t('page.notFound')}</p>
          <button type="button" className="btn" onClick={onBack}>{t('common.back')}</button>
        </section>
      </main>
    );
  }

  if (!page) {
    return (
      <main className="layout single">
        <section className="panel"><p className="empty-line">{t('common.loading')}</p></section>
      </main>
    );
  }

  return (
    <main className="layout single">
      <div className="editor-bar">
        <button type="button" className="link-btn" onClick={() => { void back(); }}>{t('common.back')}</button>
        <div className="editor-bar-right">
          <SaveIndicator state={saveState} onRetry={() => {
            void Promise.all([pageSave.flush(), tableSave.flush()]);
          }} />
          {/* 印刷レポートはサーバが組んだHTMLをそのまま別タブで開く（画面側で組み直さない） */}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              // 書きかけを送ってから開く。印刷したものと画面が食い違わないように
              void Promise.all([pageSave.flush(), tableSave.flush()])
                .then(() => window.open(api.reportUrl(page.id), '_blank', 'noopener'));
            }}
          >
            {t('report.open')}
          </button>
          <span className={`badge badge-${page.status}`}>{t(`status.${page.status}`)}</span>
          {/* 記録の確定・確定取り消しは書ける人だけ（viewerには出さない） */}
          {canEdit && (page.status === 'draft' ? (
            <button type="button" className="btn btn-small" onClick={() => setConfirmClose(true)}>
              {t('status.close')}
            </button>
          ) : (
            <button type="button" className="btn btn-small" onClick={() => { void changeStatus('draft'); }}>
              {t('status.reopen')}
            </button>
          ))}
        </div>
      </div>

      {!canEdit
        ? <p className="locked-notice">{t('role.viewerNotice')}</p>
        : readOnly && <p className="locked-notice">{t('status.lockedNotice')}</p>}

      <section className="panel">
        <label className="field">
          <span>{t('page.titleLabel')}</span>
          <input
            className="title-input"
            value={page.title}
            disabled={readOnly}
            placeholder={t('page.titlePlaceholder')}
            onChange={(e) => editPage({ title: e.target.value })}
          />
        </label>
        <label className="field field-inline">
          <span>{t('page.experimentDate')}</span>
          <input
            type="date"
            value={page.experiment_date ?? ''}
            disabled={readOnly}
            onChange={(e) => editPage({ experiment_date: e.target.value })}
          />
        </label>
      </section>

      <section className="panel">
        <h2>{t('reaction.heading')}</h2>
        <ReactionTable rows={rows} readOnly={!!readOnly} onChange={editRows} />
      </section>

      <section className="panel">
        <h2>{t('page.content')}</h2>
        <textarea
          className="content-input"
          value={page.content}
          disabled={readOnly}
          placeholder={t('page.contentPlaceholder')}
          rows={16}
          onChange={(e) => editPage({ content: e.target.value })}
        />
      </section>

      <section className="panel">
        <h2>{t('attachment.heading')}</h2>
        <AttachmentPanel pageId={page.id} readOnly={!!readOnly} />
      </section>

      <Modal
        open={confirmClose}
        title={t('status.close')}
        onClose={() => setConfirmClose(false)}
        onSubmit={() => { void changeStatus('closed'); }}
        submitLabel={t('status.close')}
      >
        <p>{t('status.closeConfirm')}</p>
      </Modal>
    </main>
  );
}
