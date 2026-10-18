// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/renderer/App.js';
import type { EnsembleAPI } from '../src/shared/api.js';
import {
  recoveryModels as models,
  recoveryTools as tools,
  recoverySubscriptions as subscriptions,
  recoveryPlan,
} from './phase-d-fixtures.js';
afterEach(cleanup);
function mockAPI() {
  const recoveries = [
    { id: 'old-apply', status: 'applied' },
    { id: 'interrupted', status: 'prepared' },
  ];
  const api: EnsembleAPI = {
    catalog: vi.fn(async () => ({
      models,
      tools,
      subscriptions,
      recoveries,
      platform: 'linux',
      sandbox: true,
    })),
    plan: vi.fn(async () => recoveryPlan()),
    preview: vi.fn(async () => ({
      id: 'preview',
      files: [{ path: '.claude/CLAUDE.md', diff: '+ recovery' }],
      exports: [],
      warnings: ['Hard-linked target'],
    })),
    apply: vi.fn(async () => ({ manifestId: 'failed-transaction', verified: false })),
    revert: vi.fn(async () => {}),
    refresh: vi.fn(async () => ({ models, changes: 0 })),
    setKey: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
  };
  return { api, recoveries };
}
it('offers applied and interrupted recovery transactions in settings in EN and TR', async () => {
  const { api } = mockAPI(),
    user = userEvent.setup();
  render(<App api={api} />);
  await user.click(screen.getByRole('button', { name: /Settings/ }));
  expect(
    await screen.findByRole('heading', { name: 'Recover / Revert previous changes' }),
  ).toBeTruthy();
  expect(screen.getByText('old-apply · Applied')).toBeTruthy();
  expect(screen.getByText('interrupted · Interrupted apply')).toBeTruthy();
  await user.click(screen.getAllByRole('button', { name: 'Revert changes' })[1]!);
  expect(api.revert).toHaveBeenCalledWith('interrupted');
  await waitFor(() => expect(screen.queryByText('interrupted · Interrupted apply')).toBeNull());
  await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'tr');
  expect(
    screen.getByRole('heading', { name: 'Önceki değişiklikleri kurtar / geri al' }),
  ).toBeTruthy();
});
it('offers recovery after an apply failure and displays a translated hard-link warning', async () => {
  const { api, recoveries } = mockAPI(),
    user = userEvent.setup();
  render(<App api={api} />);
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('checkbox', { name: /^Claude Code$/ }));
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('button', { name: 'Preview changes' }));
  expect(await screen.findByText(/A target has hard links/)).toBeTruthy();
  recoveries.push({ id: 'failed-transaction', status: 'prepared' });
  await user.click(screen.getByRole('button', { name: 'Apply to selected tools' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Apply could not finish. Use Revert below to recover previous changes.',
  );
  const item = screen.getByText('failed-transaction · Interrupted apply').closest('li')!;
  await user.click(within(item).getByRole('button', { name: 'Revert changes' }));
  expect(api.revert).toHaveBeenCalledWith('failed-transaction');
});
