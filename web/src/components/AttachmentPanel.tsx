// 添付ファイルのパネル。スペクトルのPDFやNMRの生データをページにぶら下げる。
// アップロードは生ボディPOST（サーバ側でmultipartを解かない）なので、ここも File をそのまま投げる。
// 確定済み（closed）のページでは追加・削除ができなくなるが、ダウンロードはできる。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Attachment } from '../api.ts';
import { useApp } from '../state/AppContext.tsx';
import { t } from '../i18n.ts';

interface Props {
  pageId: string;
  readOnly: boolean;
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentPanel({ pageId, readOnly }: Props) {
  const { reportError, notify } = useApp();
  const [items, setItems] = useState<Attachment[] | null>(null);
  // アップロード中のファイル名と進捗（0〜1）。nullなら何も上げていない
  const [uploading, setUploading] = useState<{ name: string; ratio: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.listAttachments(pageId));
    } catch (e) {
      reportError(e);
      setItems([]);
    }
  }, [pageId, reportError]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // 複数選ばれたら1つずつ順に上げる（同時に投げると進捗が混ざって読めない）
    for (const file of Array.from(files)) {
      setUploading({ name: file.name, ratio: 0 });
      try {
        await api.uploadAttachment(pageId, file, (ratio) => setUploading({ name: file.name, ratio }));
      } catch (e) {
        // 上限超え・確定済みページは、原因が分かる言葉にして出す
        if (e instanceof ApiError && e.status === 413) notify(t('attachment.tooLarge'));
        else if (e instanceof ApiError && e.status === 409) notify(t('attachment.pageClosed'));
        else reportError(e);
        break;
      } finally {
        setUploading(null);
      }
    }
    if (fileInput.current) fileInput.current.value = ''; // 同じファイルをもう一度選べるように
    await load();
  };

  const remove = async (attachment: Attachment) => {
    if (!window.confirm(t('attachment.deleteConfirm', { name: attachment.file_name }))) return;
    try {
      await api.deleteAttachment(attachment.id);
      setItems((current) => (current ?? []).filter((a) => a.id !== attachment.id));
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="attachments">
      {!readOnly && (
        <div className="attachment-add">
          <input
            ref={fileInput}
            type="file"
            multiple
            aria-label={t('attachment.choose')}
            disabled={uploading !== null}
            onChange={(e) => { void upload(e.target.files); }}
          />
          <span className="hint">{t('attachment.hint')}</span>
        </div>
      )}

      {uploading && (
        <div className="attachment-progress">
          <span className="attachment-progress-name">{uploading.name}</span>
          <progress max={1} value={uploading.ratio} />
          <span className="attachment-progress-pct">{Math.round(uploading.ratio * 100)}%</span>
        </div>
      )}

      {items === null ? (
        <p className="empty-line">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="empty-line">{t('attachment.empty')}</p>
      ) : (
        <ul className="attachment-list">
          {items.map((a) => (
            <li key={a.id}>
              {/* download属性は付けない。サーバがContent-Dispositionで名前まで指定している */}
              <a className="attachment-name" href={api.attachmentUrl(a.id)}>{a.file_name}</a>
              <span className="attachment-meta">
                {formatFileSize(a.file_size)}
                {a.mime_type ? ` / ${a.mime_type}` : ''}
              </span>
              {!readOnly && (
                <button type="button" className="link-btn link-danger"
                  onClick={() => { void remove(a); }}>
                  {t('common.delete')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
