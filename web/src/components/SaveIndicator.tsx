// 自動保存の状態表示。「今この記録はサーバにあるのか」が常に分かるようにする。
import type { SaveState } from '../hooks/useAutoSave.ts';
import { t } from '../i18n.ts';

export function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  if (state === 'idle') return <span className="save-indicator" aria-live="polite" />;
  return (
    <span className={`save-indicator save-${state}`} aria-live="polite">
      {state === 'saving' && <span className="save-dot" aria-hidden="true" />}
      {t(`save.${state}`)}
      {state === 'error' && onRetry && (
        <button type="button" className="link-btn" onClick={onRetry}>{t('save.retry')}</button>
      )}
    </span>
  );
}
