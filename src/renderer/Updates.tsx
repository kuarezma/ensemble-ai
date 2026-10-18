import { useEffect, useState } from 'react';
import type { EnsembleAPI, UpdateAction, UpdateState } from '../shared/api.js';
import type { TextKey } from './App.js';

export function useUpdates(api: EnsembleAPI) {
  const [state, setState] = useState<UpdateState>();
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = () =>
      api
        .update({ type: 'status' })
        .then((next) => {
          if (active) {
            setState(next);
            setFailure(false);
            if (next.status === 'dev' && timer) {
              clearInterval(timer);
              timer = undefined;
            }
          }
        })
        .catch(() => {
          if (active) setFailure(true);
        });
    void poll();
    timer = setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [api]);
  async function action(value: UpdateAction) {
    if (value.type === 'configure') {
      setState((previous) => previous && { ...previous, enabled: value.enabled });
    }
    try {
      setState(await api.update(value));
      setFailure(false);
    } catch {
      setFailure(true);
    }
  }
  return { state, failure, action };
}
export function UpdateConsent({
  updates,
  t,
}: {
  updates: ReturnType<typeof useUpdates>;
  t: (key: TextKey) => string;
}) {
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={updates.state?.enabled ?? true}
          disabled={!updates.state}
          onChange={(event) =>
            void updates.action({ type: 'configure', enabled: event.target.checked })
          }
        />
        {t('updateConsent')}
      </label>
      <p className="muted">{t('updateConsentBody')}</p>
      {updates.failure && <p role="status">{t('updateError')}</p>}
    </>
  );
}
export function UpdateSettings({
  updates,
  t,
}: {
  updates: ReturnType<typeof useUpdates>;
  t: (key: TextKey) => string;
}) {
  const status = updates.state?.status;
  const keys = {
    idle: 'updateIdle',
    dev: 'updateDev',
    checking: 'updateChecking',
    'up-to-date': 'updateCurrent',
    downloading: 'updateDownloading',
    ready: 'updateReady',
    available: 'updateAvailable',
    error: 'updateError',
  } as const;
  return (
    <div className="card update-settings">
      <h2>{t('updates')}</h2>
      <p>
        {t('currentVersion')}: {updates.state?.currentVersion ?? '—'}
      </p>
      <UpdateConsent updates={updates} t={t} />
      <p role="status" data-testid="update-status">
        {t(updates.failure ? 'updateError' : keys[status ?? 'idle'])}
        {status === 'downloading' && ` ${updates.state?.percent ?? 0}%`}
        {(status === 'ready' || status === 'available') && ` ${updates.state?.version ?? ''}`}
      </p>
      <button
        disabled={!status || ['checking', 'downloading', 'ready', 'dev'].includes(status)}
        onClick={() => void updates.action({ type: 'check' })}
      >
        {t('updateCheck')}
      </button>
      {status === 'ready' && (
        <button onClick={() => void updates.action({ type: 'restart' })}>
          {t('updateRestart')}
        </button>
      )}
      {(status === 'available' || status === 'error') && (
        <button onClick={() => void updates.action({ type: 'download' })}>
          {t('updateDownload')}
        </button>
      )}
    </div>
  );
}
export function UpdateBanner({
  updates,
  t,
}: {
  updates: ReturnType<typeof useUpdates>;
  t: (key: TextKey) => string;
}) {
  const [dismissed, setDismissed] = useState('');
  const state = updates.state;
  const id = `${state?.status}:${state?.version}`;
  if (!state || !['ready', 'available'].includes(state.status) || dismissed === id) return null;
  return (
    <div className="notice update-banner" aria-label={t('updates')}>
      <p role="status">
        {t(state.status === 'ready' ? 'updateBannerReady' : 'updateBannerAvailable').replace(
          '{version}',
          state.version ?? '',
        )}
      </p>
      <div className="update-actions">
        <button
          onClick={() =>
            void updates.action({ type: state.status === 'ready' ? 'restart' : 'download' })
          }
        >
          {t(state.status === 'ready' ? 'updateRestart' : 'updateDownload')}
        </button>
        <button onClick={() => setDismissed(id)}>{t('updateLater')}</button>
        <a
          href="https://github.com/kuarezma/ensemble-ai/releases/latest"
          onClick={(event) => {
            event.preventDefault();
            void updates.action({ type: 'notes' });
          }}
        >
          {t('updateNotes')}
        </a>
      </div>
    </div>
  );
}
