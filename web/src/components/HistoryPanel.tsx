// 履歴パネル。ページに紐づく操作ログ（audit_events）と改訂履歴（page_revisions）を
// 読み取り専用で出す。既定は畳んでいて、開いたときに初めてAPIを取りに行く
// （ページを開くたびに重い読み込みを走らせないため）。
// 403（見る権限が無い）ならその節を出さず、他の失敗は「取得できませんでした」の
// 1行に留めて、画面全体は壊さない。
import { useState, type SyntheticEvent } from 'react';
import {
  api, ApiError,
  type AuditEvent, type PageRevision, type PageRevisionSnapshot,
} from '../api.ts';
import { getLocale, t, type MessageKey } from '../i18n.ts';

// action の表示名。辞書に無い action は文字列をそのまま出す
// （サーバ側に操作が増えても、ここを直すまでの間、画面が壊れないように）
const ACTION_LABEL_KEYS: Record<string, MessageKey> = {
  'page.create': 'history.action.pageCreate',
  'page.update': 'history.action.pageUpdate',
  'page.close': 'history.action.pageClose',
  'page.reopen': 'history.action.pageReopen',
  'page.delete': 'history.action.pageDelete',
  'molecules.replace': 'history.action.moleculesReplace',
  'attachment.create': 'history.action.attachmentCreate',
  'attachment.delete': 'history.action.attachmentDelete',
};

// before/after の項目名を画面の文言へ。載っていない項目名はそのまま出す
const FIELD_LABEL_KEYS: Record<string, MessageKey> = {
  title: 'page.titleLabel',
  experiment_date: 'page.experimentDate',
  status: 'common.status',
  content: 'page.content',
};

// ISO文字列を画面の言語の日時表示に（ノート一覧の formatDateTime と同じ形）
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(getLocale() === 'en' ? 'en-US' : 'ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// before_json / after_json はJSON文字列かnull。壊れたJSONが来てもその行だけで止める
function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

// 値の表示。空は「—」。status の値だけは画面の状態表示と同じ言葉に揃える
function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'status' && (value === 'draft' || value === 'closed')) {
    return t(`status.${value}`);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// 取得状態。forbidden（403）は「その節を出さない」の合図
type FetchState<T> =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; data: T };

// 1事象の「変更前 → 変更後」。項目ごとに1行
function EventDiff({ before, after }: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (keys.length === 0) return null;
  return (
    <table className="history-diff">
      <thead>
        <tr>
          <th aria-label="" />
          <th>{t('history.before')}</th>
          <th>{t('history.after')}</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr key={key}>
            <th>{FIELD_LABEL_KEYS[key] ? t(FIELD_LABEL_KEYS[key]) : key}</th>
            <td>{formatValue(key, before?.[key])}</td>
            <td>{formatValue(key, after?.[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 操作ログの1行。いつ・誰が・何をしたか。変更の中身は行を開いたときだけ見せる
function AuditEventRow({ event }: { event: AuditEvent }) {
  const before = parseJsonObject(event.before_json);
  const after = parseJsonObject(event.after_json);
  const actionKey = ACTION_LABEL_KEYS[event.action];
  const line = (
    <>
      <span className="history-when">{formatDateTime(event.at)}</span>
      <span className="history-actor">{event.actor_email || event.actor_user_id}</span>
      <span className="history-what">{actionKey ? t(actionKey) : event.action}</span>
      {event.reason !== '' && (
        <span className="history-reason">{t('history.reason')}: {event.reason}</span>
      )}
    </>
  );
  // 変更の中身が無い行は1行表示で終わり（畳み込みの要らない行に開ける余地を作らない）
  if (before === null && after === null) return <li className="history-line">{line}</li>;
  return (
    <li className="history-line">
      <details>
        <summary>{line}</summary>
        <EventDiff before={before} after={after} />
      </details>
    </li>
  );
}

// 改訂履歴の1行。開いたときにその版のスナップショットを取る（一覧には本文が載らないため）
function RevisionRow({ pageId, rev }: { pageId: string; rev: PageRevision }) {
  // null = まだ取っていない / 'loading' / 'failed' / スナップショット
  const [snapshot, setSnapshot] = useState<PageRevisionSnapshot | 'loading' | 'failed' | null>(null);

  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || snapshot !== null) return;
    setSnapshot('loading');
    api.getPageRevision(pageId, rev.rev_no)
      .then((r) => setSnapshot(r.snapshot))
      .catch(() => setSnapshot('failed'));
  };

  return (
    <li className="history-line">
      <details onToggle={onToggle}>
        <summary>
          <span className="history-what">{t('history.revNo', { no: rev.rev_no })}</span>
          <span className="history-when">{formatDateTime(rev.created_at)}</span>
        </summary>
        {snapshot === 'loading' && <p className="hint">{t('common.loading')}</p>}
        {snapshot === 'failed' && <p className="hint">{t('history.fetchFailed')}</p>}
        {typeof snapshot === 'object' && snapshot !== null && (
          <dl className="history-snapshot">
            <dt>{t('page.titleLabel')}</dt>
            <dd>{snapshot.page?.title || '—'}</dd>
            <dt>{t('page.experimentDate')}</dt>
            <dd>{snapshot.page?.experiment_date || '—'}</dd>
            <dt>{t('page.content')}</dt>
            <dd className="history-snapshot-content">{snapshot.page?.content || '—'}</dd>
          </dl>
        )}
      </details>
    </li>
  );
}

export function HistoryPanel({ pageId }: { pageId: string }) {
  // 開かれたことがあるか。一度開いたら、閉じても再取得はしない
  const [requested, setRequested] = useState(false);
  const [audit, setAudit] = useState<FetchState<AuditEvent[]>>({ kind: 'loading' });
  const [revisions, setRevisions] = useState<FetchState<PageRevision[]>>({ kind: 'loading' });

  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || requested) return;
    setRequested(true);
    // 操作ログと改訂履歴は別々に取る。片方が403・失敗でももう片方は出す
    api.listPageAudit(pageId)
      .then((r) => setAudit({ kind: 'ok', data: r.events }))
      .catch((err: unknown) => setAudit({
        kind: err instanceof ApiError && err.status === 403 ? 'forbidden' : 'failed',
      }));
    api.listPageRevisions(pageId)
      .then((r) => setRevisions({ kind: 'ok', data: r.revisions }))
      .catch((err: unknown) => setRevisions({
        kind: err instanceof ApiError && err.status === 403 ? 'forbidden' : 'failed',
      }));
  };

  // どちらの節も出せない（403）なら、パネル自体を出さない
  if (requested && audit.kind === 'forbidden' && revisions.kind === 'forbidden') return null;

  return (
    <section className="panel history-panel">
      <details onToggle={onToggle}>
        <summary className="history-summary">{t('history.heading')}</summary>
        <div className="history-body">
          {audit.kind !== 'forbidden' && (
            <section className="history-section">
              <h3 className="history-subhead">{t('history.audit')}</h3>
              {audit.kind === 'loading' && <p className="empty-line">{t('common.loading')}</p>}
              {audit.kind === 'failed' && <p className="empty-line">{t('history.fetchFailed')}</p>}
              {audit.kind === 'ok' && (audit.data.length === 0 ? (
                <p className="empty-line">{t('history.empty')}</p>
              ) : (
                <ul className="history-list">
                  {audit.data.map((event) => <AuditEventRow key={event.id} event={event} />)}
                </ul>
              ))}
            </section>
          )}
          {revisions.kind !== 'forbidden' && (
            <section className="history-section">
              <h3 className="history-subhead">{t('history.revisions')}</h3>
              {revisions.kind === 'loading' && <p className="empty-line">{t('common.loading')}</p>}
              {revisions.kind === 'failed' && <p className="empty-line">{t('history.fetchFailed')}</p>}
              {revisions.kind === 'ok' && (revisions.data.length === 0 ? (
                <p className="empty-line">{t('history.empty')}</p>
              ) : (
                <ul className="history-list">
                  {/* 一覧はrev_no昇順で返る。新しい版を上に出したいので反転する */}
                  {[...revisions.data].reverse().map((rev) => (
                    <RevisionRow key={rev.rev_no} pageId={pageId} rev={rev} />
                  ))}
                </ul>
              ))}
            </section>
          )}
        </div>
      </details>
    </section>
  );
}
