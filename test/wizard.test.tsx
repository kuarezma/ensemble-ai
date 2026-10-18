// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/renderer/App.js';
import modelsJSON from '../catalog/models.json' with { type: 'json' };
import toolsJSON from '../catalog/tools.json' with { type: 'json' };
import subscriptionsJSON from '../catalog/plans.json' with { type: 'json' };
import { z } from 'zod';
import { ModelSchema, ToolSchema, SubscriptionSchema } from '../src/core/schemas.js';
const models = z.array(ModelSchema).parse(modelsJSON);
const tools = z.array(ToolSchema).parse(toolsJSON);
const subscriptions = z.array(SubscriptionSchema).parse(subscriptionsJSON);
import { generatePlan } from '../src/core/engine/index.js';
import type { EnsembleAPI } from '../src/shared/api.js';
function mockAPI(): EnsembleAPI {
  return {
    catalog: vi.fn(async () => ({
      models,
      tools,
      subscriptions,
      platform: 'darwin',
      sandbox: true,
    })),
    plan: vi.fn(async (input) => generatePlan(input)),
    preview: vi.fn(async () => ({
      id: 'preview',
      files: [{ path: '.codex/AGENTS.md', diff: '+ crew' }],
      exports: [],
    })),
    apply: vi.fn(async () => ({ manifestId: 'transaction', verified: true })),
    revert: vi.fn(async () => {}),
    refresh: vi.fn(async () => ({ models, changes: 0 })),
    setKey: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
  };
}
afterEach(cleanup);
describe('wizard', () => {
  it('finishes five steps, reviews a diff, applies explicitly and reverts', async () => {
    const api = mockAPI(),
      user = userEvent.setup();
    render(<App api={api} />);
    expect(screen.getByRole('heading', { name: 'Your models, working together.' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Keep model data up to date' })).toHaveProperty(
      'checked',
      true,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Continue/ })).toHaveProperty('disabled', false),
    );
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(screen.getByRole('button', { name: /Continue/ })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('checkbox', { name: 'Claude Code' }));
    await user.click(screen.getByRole('checkbox', { name: 'Codex CLI' }));
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    await user.click(screen.getByRole('button', { name: /Quality/ }));
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(screen.getAllByRole('article')).toHaveLength(6);
    const role = screen.getAllByRole('article')[2]!;
    await user.click(within(role).getByRole('button', { name: 'Lock Builder' }));
    await waitFor(() =>
      expect(within(role).getByRole('button', { name: 'Unlock Builder' })).toBeTruthy(),
    );
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(api.apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByText('+ crew')).toBeTruthy();
    expect(api.apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply to selected tools' }));
    expect(await screen.findByRole('heading', { name: 'Your crew is ready.' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Revert changes' }));
    expect(api.revert).toHaveBeenCalledWith('transaction');
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'Changes reverted. Your original files are restored.',
    );
  });
  it('switches language and exposes settings without a network request', async () => {
    const api = mockAPI(),
      user = userEvent.setup();
    render(<App api={api} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'tr');
    expect(screen.getByRole('heading', { name: 'Modelleriniz birlikte çalışsın.' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Ayarlar/ }));
    expect(screen.getByRole('heading', { name: 'Ayarlar' })).toBeTruthy();
    expect(api.refresh).not.toHaveBeenCalled();
  });
});

it('requires review and acceptance before refreshed models affect the crew', async () => {
  const api = mockAPI(),
    user = userEvent.setup();
  const provisional = {
    ...models[0]!,
    id: 'research-candidate',
    name: 'Research candidate',
    provisional: true,
  };
  vi.mocked(api.refresh).mockResolvedValue({ models: [...models, provisional], changes: 1 });
  render(<App api={api} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Continue/ })).toHaveProperty('disabled', false),
  );
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Codex CLI' }));
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await screen.findByRole('heading', { name: 'Meet your crew.' });
  await user.click(screen.getByRole('button', { name: /Settings/ }));
  await user.click(screen.getByRole('button', { name: 'Refresh model data' }));
  const group = await screen.findByRole('group', { name: 'Research candidate' });
  expect(within(group).getByRole('checkbox', { name: 'Codex CLI' })).toHaveProperty(
    'checked',
    false,
  );
  await user.click(within(group).getByRole('checkbox', { name: 'Codex CLI' }));
  await user.click(screen.getByRole('button', { name: 'Review updated crew' }));
  expect(await screen.findByRole('heading', { name: 'What changed and why' })).toBeTruthy();
  expect(api.apply).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Accept updated plan' }));
  expect(await screen.findByRole('heading', { name: 'Meet your crew.' })).toBeTruthy();
  expect(api.apply).not.toHaveBeenCalled();
});

it('changes a manually chosen coordinator without conflicting with its override', async () => {
  const api = mockAPI(),
    user = userEvent.setup();
  render(<App api={api} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Continue/ })).toHaveProperty('disabled', false),
  );
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Codex CLI' }));
  await user.click(screen.getByRole('checkbox', { name: 'Claude Code' }));
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('button', { name: 'I choose the coordinator' }));
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  const coordinator = (await screen.findAllByRole('article'))[0]!;
  await user.click(within(coordinator).getByRole('button', { name: 'Change' }));
  const select = within(coordinator).getByRole('combobox', { name: 'Model' });
  const options = within(select).getAllByRole('option');
  const alternative = options.find(
    (option) => (option as HTMLOptionElement).value !== (select as HTMLSelectElement).value,
  )!;
  await user.selectOptions(select, (alternative as HTMLOptionElement).value);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(within(coordinator).getByRole('button', { name: 'Unlock Coordinator' })).toBeTruthy();
});

it('exports a portable plan with assignments and imports it without applying files', async () => {
  const api = mockAPI(),
    user = userEvent.setup();
  render(<App api={api} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Continue/ })).toHaveProperty('disabled', false),
  );
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Codex CLI' }));
  await user.click(screen.getByRole('button', { name: /Settings/ }));
  await user.click(screen.getByRole('button', { name: 'Export plan JSON' }));
  const exported = vi.mocked(api.copy).mock.calls[0]![0];
  expect(JSON.parse(exported).plan.assignments.builder).toBeTruthy();
  // Paste the exported text without keyboard punctuation being interpreted as shortcuts.
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(screen.getByRole('textbox', { name: 'Plan configuration' }), {
    target: { value: exported },
  });
  await user.click(screen.getByRole('button', { name: 'Load configuration' }));
  expect(await screen.findByRole('heading', { name: 'Meet your crew.' })).toBeTruthy();
  expect(api.apply).not.toHaveBeenCalled();
});
