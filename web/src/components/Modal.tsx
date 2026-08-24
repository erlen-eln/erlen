// 小さなモーダル。ノートブックの作成／リネーム、削除の確認に使う。
// ダイアログ用のUIライブラリは入れず、<dialog> の素の挙動（Escで閉じる・背面を不活性にする）に乗る。
import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../i18n.ts';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  submitDanger?: boolean;
  // 一覧を載せるモーダル（試薬マスタの検索）だけ横幅を広げる
  wide?: boolean;
  children: ReactNode;
}

export function Modal({
  open, title, onClose, onSubmit, submitLabel, submitDanger, wide, children,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className={wide ? 'modal modal-wide' : 'modal'}
      ref={ref}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          // Enterでも決定できるようにする（onSubmitが無いモーダルは閉じるだけ）
          e.preventDefault();
          if (onSubmit) onSubmit();
          else onClose();
        }}
      >
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          {onSubmit && (
            <button type="submit" className={submitDanger ? 'btn btn-danger' : 'btn btn-primary'}>
              {submitLabel ?? t('common.ok')}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
