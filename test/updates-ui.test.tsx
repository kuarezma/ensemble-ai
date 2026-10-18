// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/renderer/App.js';
import { UpdateBanner, UpdateSettings } from '../src/renderer/Updates.js';
import type { EnsembleAPI, UpdateState } from '../src/shared/api.js';
import en from '../src/renderer/i18n/en.json' with { type: 'json' };
import {
  recoveryModels as models,
  recoveryTools as tools,
  recoverySubscriptions as subscriptions,
} from './phase-d-fixtures.js';
afterEach(cleanup);
it('shares persisted automatic-update consent between Welcome and Settings with EN/TR labels', async () => {
  let enabled = false;
  const update = vi.fn<EnsembleAPI['update']>(async (action) => {
    if (action.type === 'configure') enabled = action.enabled;
    return { currentVersion: '0.1.1', enabled, status: 'idle' };
  });
  const unused = vi.fn(async () => {
    throw new Error('Unexpected test API call');
  });
  const api: EnsembleAPI = {
    plan: unused,
    preview: unused,
    apply: unused,
    revert: unused,
    refresh: unused,
    setKey: unused,
    copy: unused,
    update,
    catalog: async () => ({ models, tools, subscriptions, platform: 'linux', sandbox: true }),
  };
  const user = userEvent.setup();
  render(<App api={api} />);
  const consent = await screen.findByRole('checkbox', { name: 'Check for updates automatically' });
  await waitFor(() => expect(consent).toHaveProperty('disabled', false));
  expect(consent).toHaveProperty('checked', false);
  await user.click(consent);
  expect(update).toHaveBeenCalledWith({ type: 'configure', enabled: true });
  await user.click(screen.getByRole('button', { name: /Settings/ }));
  expect(screen.getByText('Current version: 0.1.1')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Check for updates automatically' })).toHaveProperty(
    'checked',
    true,
  );
  await user.click(screen.getByRole('button', { name: 'Check now' }));
  expect(update).toHaveBeenCalledWith({ type: 'check' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'tr');
  expect(screen.getByRole('checkbox', { name: 'Güncellemeleri otomatik denetle' })).toBeTruthy();
});
it('Later dismisses the banner while Settings retains explicit restart; fallback opens Download', async () => {
  const user = userEvent.setup();
  const action = vi.fn(async () => {});
  const state: UpdateState = {
    currentVersion: '0.1.1',
    enabled: true,
    status: 'ready',
    version: '0.1.2',
  };
  const updates = { state, failure: false, action };
  const t = (key: keyof typeof en) => en[key];
  const { rerender } = render(
    <>
      <UpdateBanner updates={updates} t={t} />
      <UpdateSettings updates={updates} t={t} />
    </>,
  );
  expect(action).not.toHaveBeenCalled();
  await user.click(screen.getByRole('link', { name: 'Release notes' }));
  expect(action).toHaveBeenCalledWith({ type: 'notes' });
  await user.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.queryByText('Update ready: version 0.1.2. Restart to update')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Restart now' }));
  expect(action).toHaveBeenCalledWith({ type: 'restart' });
  rerender(
    <UpdateBanner updates={{ ...updates, state: { ...state, status: 'available' } }} t={t} />,
  );
  expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Download' }));
  expect(action).toHaveBeenCalledWith({ type: 'download' });
});
