import { useEffect, useRef, useState, type ReactNode } from 'react';
import en from './i18n/en.json' with { type: 'json' };
import tr from './i18n/tr.json' with { type: 'json' };
import {
  roles,
  EngineInputSchema,
  ModelSchema,
  PlanSchema,
  type AccessibleModel,
  type Assignment,
  type EngineInput,
  type Model,
  type Plan,
  type Role,
} from '../core/schemas.js';
import { allowed, candidatesFor } from '../core/engine/policy.js';
import type { Catalog, EnsembleAPI, Preview, Recovery } from '../shared/api.js';
import { explain } from './explain.js';
import { useUpdates, UpdateConsent, UpdateSettings, UpdateBanner } from './Updates.js';
import { platformAdapter } from './platform/index.js';
export type TextKey = keyof typeof en;
type Selection = {
  plan: string;
  hidden: string[];
  scarcity: number;
  efforts?: Record<string, string[]>;
};
export function App({ api = window.ensemble }: { api?: EnsembleAPI }) {
  const updates = useUpdates(api);
  const [lang, setLang] = useState<'en' | 'tr'>('en');
  const t = (key: TextKey) => (lang === 'en' ? en : tr)[key];
  const [catalog, setCatalog] = useState<Catalog>();
  const [step, setStep] = useState(0),
    [settings, setSettings] = useState(false);
  const [theme, setTheme] = useState('system'),
    [consent, setConsent] = useState(true);
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [search, setSearch] = useState(''),
    [profile, setProfile] = useState<EngineInput['profile']>('balanced');
  const [manual, setManual] = useState(''),
    [locks, setLocks] = useState<Partial<Record<Role, Assignment>>>({});
  const [plan, setPlan] = useState<Plan>(),
    [preview, setPreview] = useState<Preview>();
  const [targets, setTargets] = useState<string[]>(),
    [manifest, setManifest] = useState<string | null>();
  const [applied, setApplied] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<TextKey>();
  const [error, setError] = useState<TextKey>(),
    [editing, setEditing] = useState<Role>();
  const [key, setKey] = useState(''),
    [json, setJson] = useState('');
  const [fresh, setFresh] = useState<Model[]>(),
    [confirmed, setConfirmed] = useState<Record<string, string[]>>({});
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const [candidate, setCandidate] = useState<Plan>();
  const heading = useRef<HTMLHeadingElement>(null),
    settingsHeading = useRef<HTMLHeadingElement>(null),
    settingsButton = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const adapter = platformAdapter(catalog?.platform ?? 'linux');
  useEffect(() => {
    if (api)
      api
        .catalog()
        .then((result: Catalog) => {
          setCatalog(result);
          setRecoveries(result.recoveries ?? []);
        })
        .catch(() => setError('error'));
  }, [api]);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.theme = theme;
  }, [lang, theme]);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (settings) settingsHeading.current?.focus();
    const listener = (e: KeyboardEvent) => {
      if (adapter.isSettingsShortcut(e)) {
        e.preventDefault();
        setSettings((s) => !s);
      }
      if (e.key === 'Escape' && settings) {
        setSettings(false);
        settingsButton.current?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [settings, catalog?.platform]); // platform determines keyboard conventions
  function Tip({
    text,
    children,
    focusable = true,
  }: {
    text: TextKey;
    children: ReactNode;
    focusable?: boolean;
  }) {
    return (
      <span className="term" tabIndex={focusable ? 0 : undefined}>
        {children}
        <span role="tooltip">{t(text)}</span>
      </span>
    );
  }
  function toggleTool(id: string) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else {
        const sub = catalog?.subscriptions.find((s) => s.via === id);
        next[id] = { plan: sub?.id ?? '', hidden: [], scarcity: sub?.scarcity ?? 2 };
      }
      return next;
    });
    setLocks({});
    setManual('');
    setTargets(undefined);
    setPlan(undefined);
    setPreview(undefined);
    setApplied(false);
  }
  function accessFor(
    data: Model[] = catalog?.models ?? [],
    confirmations = confirmed,
  ): AccessibleModel[] {
    return Object.entries(selected).flatMap(([via, choice]) => {
      const sub = catalog?.subscriptions.find((s) => s.id === choice.plan);
      const hasSubModels = Boolean(sub && sub.models.length > 0);
      return data.flatMap((m) => {
        const provisionalAccess = m.provisional && confirmations[m.id]?.includes(via);
        const entry = sub?.models.find((x) => x.model === m.id);
        if (
          choice.hidden.includes(m.id) ||
          (m.provisional ? !provisionalAccess : hasSubModels ? !entry : false)
        )
          return [];
        const tiers = entry ? m.efforts.filter((e) => entry.efforts.includes(e.effort)) : m.efforts;
        const efforts = choice.efforts?.[m.id]
          ? tiers.filter((e) => choice.efforts![m.id]!.includes(e.effort))
          : tiers;
        return efforts.length
          ? [{ ...m, efforts, via, scarcity: choice.scarcity as 1 | 2 | 3 }]
          : [];
      });
    });
  }
  const accessible = accessFor();
  function validEfforts(m: AccessibleModel, role?: Role) {
    if (!role) return m.efforts;
    const permitted = new Set(
      candidatesFor(m)
        .filter((c) => allowed(c, role))
        .map((c) => c.effort),
    );
    return m.efforts.filter((e) => permitted.has(e.effort));
  }
  function input(data?: Model[]): EngineInput {
    const models = accessFor(data);
    const [manualModel, manualVia] = manual ? manual.split('|') : [];
    const hasValidManual = Boolean(
      manualModel &&
      manualVia &&
      models.some(
        (m) =>
          m.id === manualModel && m.via === manualVia && validEfforts(m, 'orchestrator').length > 0,
      ),
    );
    return {
      accessible: models,
      profile,
      tools: Object.keys(selected),
      locks,
      ...(hasValidManual ? { orchestratorOverride: { model: manualModel!, via: manualVia! } } : {}),
    };
  }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await action();
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : '';
      if (/File changed|Preview expired|Revert conflict|changed during revert/.test(detail)) {
        setPreview(undefined);
        setError('fileConflict');
      } else if (/Locked builder and reviewer|Orchestrator lock conflicts/.test(detail))
        setError('roleConflict');
      else if (/Secure storage unavailable/.test(detail)) setError('keyError');
      else if (failure instanceof SyntaxError || /ZodError|invalid_type|invalid_value/.test(detail))
        setError('invalidJson');
      else setError('error');
    } finally {
      setBusy(false);
    }
  }
  async function reloadRecoveries() {
    const result: Catalog = await api!.catalog();
    setRecoveries(result.recoveries ?? []);
    return result.recoveries ?? [];
  }
  async function revertTransaction(id: string) {
    await api!.revert(id);
    setRecoveries((previous) => previous.filter((item) => item.id !== id));
    setApplied(false);
    setManifest(null);
    setPreview(undefined);
    setMessage('reverted');
  }
  function recoveryList() {
    return (
      <div className="card">
        <h2>{t('recoveryTitle')}</h2>
        <p>{t('recoveryBody')}</p>
        {recoveries.length ? (
          <ul>
            {recoveries.map((item) => (
              <li key={item.id}>
                <span>
                  {item.id} ·{' '}
                  {t(item.status === 'prepared' ? 'recoveryPrepared' : 'recoveryApplied')}
                </span>{' '}
                <button
                  disabled={busy}
                  onClick={() => void perform(() => revertTransaction(item.id))}
                >
                  {t('revert')}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('recoveryEmpty')}</p>
        )}
      </div>
    );
  }
  async function makePlan(override?: EngineInput) {
    const version = ++request.current;
    const result = await api!.plan(override ?? input());
    if (version === request.current) {
      setPlan(result);
      setPreview(undefined);
      setApplied(false);
    }
    return result;
  }
  async function next() {
    await perform(async () => {
      if (step === 2) await makePlan();
      setStep((s) => Math.min(4, s + 1));
    });
  }
  function invalidate() {
    setPreview(undefined);
    setApplied(false);
    setPlan(undefined);
    setLocks({});
    setManual('');
  }
  function choiceOptions(role?: Role) {
    return accessible
      .filter((m) => validEfforts(m, role).length > 0)
      .map((m) => (
        <option key={m.id + m.via} value={m.id + '|' + m.via}>
          {m.name} · {catalog?.tools.find((t) => t.id === m.via)?.name}
        </option>
      ));
  }
  const stepKeys = ['welcome', 'tools', 'style', 'crew', 'applyStep'] as const;
  const titles = ['welcomeTitle', 'toolsTitle', 'styleTitle', 'crewTitle', 'applyTitle'] as const;
  const bodies = ['welcomeBody', 'toolsBody', 'styleBody', 'crewBody', 'applyBody'] as const;
  if (!api)
    return (
      <main className="standalone">
        <h1>{t('app')}</h1>
        <p>{t('bridgeMissing')}</p>
      </main>
    );
  return (
    <div className={`shell platform-${adapter.kind}`}>
      <aside className="rail" aria-label={t('summary')}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 1024 1024" width="40" height="40" aria-hidden="true">
              <rect x="100" y="100" width="824" height="824" rx="190" fill="#2c48b8" />
              <rect x="330" y="470" width="310" height="84" rx="42" fill="#25c7a2" />
              <g fill="#fff">
                <rect x="296" y="286" width="84" height="452" rx="42" />
                <rect x="296" y="286" width="392" height="84" rx="42" />
                <rect x="296" y="654" width="392" height="84" rx="42" />
              </g>
            </svg>
          </span>
          <strong>{t('app')}</strong>
        </div>
        <p className="rail-tagline">{t('tagline')}</p>
        <nav aria-label={t('steps')}>
          <ol>
            {stepKeys.map((s, i) => (
              <li key={s} aria-current={!settings && step === i ? 'step' : undefined}>
                <span className="step-number">{i < step ? '✓' : i + 1}</span>
                {t(s)}
              </li>
            ))}
          </ol>
        </nav>
        <div className="setup-summary">
          <p className="eyebrow">{t('summary')}</p>
          <p>{t('summaryBody')}</p>
          <dl>
            <div>
              <dt>{t('selectedTools')}</dt>
              <dd>{Object.keys(selected).length}</dd>
            </div>
            <div>
              <dt>{t('selectedModels')}</dt>
              <dd>{accessible.length}</dd>
            </div>
            <div>
              <dt>{t('profile')}</dt>
              <dd>{t(profile)}</dd>
            </div>
          </dl>
        </div>
        <button
          ref={settingsButton}
          className="settings-button"
          aria-expanded={settings}
          onClick={() => {
            setSettings(!settings);
            setError(undefined);
            setMessage(undefined);
          }}
        >
          {settings ? t('close') : t('settings')}
          <kbd>{adapter.settingsShortcut}</kbd>
        </button>
      </aside>
      <main className="workspace" aria-busy={busy}>
        <header className="topbar">
          <span>{settings ? t('settings') : `${t('step')} ${step + 1} ${t('of')} 5`}</span>
          <label className="language">
            <span className="sr-only">{t('language')}</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'tr')}>
              <option value="en">{t('english')}</option>
              <option value="tr">{t('turkish')}</option>
            </select>
          </label>
        </header>
        <UpdateBanner updates={updates} t={t} />
        {error && (
          <div role="alert" className="notice error">
            {t(error)}
          </div>
        )}
        {message && (
          <div role="status" className="notice">
            {t(message)}
          </div>
        )}
        {busy && <p role="status">{t('loading')}</p>}
        {settings ? (
          <section className="content settings">
            <p className="eyebrow">{t('app')}</p>
            <h1 ref={settingsHeading} tabIndex={-1}>
              {t('settings')}
            </h1>
            <UpdateSettings updates={updates} t={t} />
            {recoveryList()}
            <label>
              {t('theme')}
              <select value={theme} onChange={(e) => setTheme(e.target.value)}>
                {(['system', 'light', 'dark'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t(v)}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              {t('refreshConsent')}
            </label>
            <p className="muted">{t('consentBody')}</p>
            <button
              disabled={busy || !consent}
              onClick={() =>
                void perform(async () => {
                  if (!accessible.length) {
                    setMessage('refreshNeedsPlan');
                    return;
                  }
                  if (!plan) await makePlan();
                  const result = await api.refresh(consent);
                  setFresh(result.models);
                  setCandidate(undefined);
                  setConfirmed({});
                  setMessage('refreshDone');
                })
              }
            >
              {t('refresh')}
            </button>
            <label>
              {t('apiKey')}
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <p className="muted">{t('keyHint')}</p>
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api.setKey(key);
                  setKey('');
                  setMessage('keySaved');
                })
              }
            >
              {t('saveKey')}
            </button>
            {fresh && (
              <div className="card refresh-review">
                <h2>
                  <Tip text="provisionalTip">{t('provisional')}</Tip>
                </h2>
                {fresh
                  .filter((m) => m.provisional)
                  .map((m) => (
                    <fieldset key={m.id}>
                      <legend>{m.name}</legend>
                      {Object.keys(selected).map((id) => (
                        <label className="check" key={id}>
                          <input
                            type="checkbox"
                            checked={confirmed[m.id]?.includes(id) ?? false}
                            disabled={!!candidate}
                            onChange={(e) =>
                              setConfirmed((prev) => ({
                                ...prev,
                                [m.id]: e.target.checked
                                  ? [...(prev[m.id] ?? []), id]
                                  : (prev[m.id] ?? []).filter((x) => x !== id),
                              }))
                            }
                          />
                          {catalog?.tools.find((t) => t.id === id)?.name}
                        </label>
                      ))}
                    </fieldset>
                  ))}
                {!candidate && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setCandidate(await api.plan(input(fresh)));
                        setPreview(undefined);
                      })
                    }
                  >
                    {t('reviewRefresh')}
                  </button>
                )}
                {candidate && (
                  <>
                    <h3>{t('planDiff')}</h3>
                    <p>{t('refreshWhy')}</p>
                    {roles
                      .filter(
                        (r) =>
                          JSON.stringify(plan?.assignments[r]) !==
                          JSON.stringify(candidate.assignments[r]),
                      )
                      .map((r) => (
                        <div className="plan-change" key={r}>
                          <strong>{t(r)}</strong>
                          <p>
                            {plan?.assignments[r].model} · {plan?.assignments[r].effort} →{' '}
                            {candidate.assignments[r].model} · {candidate.assignments[r].effort}
                          </p>
                          <p>{t('whySummary')}</p>
                        </div>
                      ))}
                    {roles.every(
                      (r) =>
                        JSON.stringify(plan?.assignments[r]) ===
                        JSON.stringify(candidate.assignments[r]),
                    ) && <p>{t('noPlanDiff')}</p>}
                    <button
                      disabled={busy}
                      className="primary"
                      onClick={() => {
                        setCatalog((c) => (c ? { ...c, models: fresh } : c));
                        setPlan(candidate);
                        setFresh(undefined);
                        setCandidate(undefined);
                        setApplied(false);
                        setSettings(false);
                        setStep(3);
                      }}
                    >
                      {t('acceptRefresh')}
                    </button>
                  </>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await makePlan();
                      setFresh(undefined);
                      setCandidate(undefined);
                      setConfirmed({});
                    })
                  }
                >
                  {t('discard')}
                </button>
              </div>
            )}
            <hr />
            <h2>
              <Tip text="jsonTip">{t('importPlan')}</Tip>
            </h2>
            <label>
              {t('importText')}
              <textarea rows={5} value={json} onChange={(e) => setJson(e.target.value)} />
            </label>
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const raw: unknown = JSON.parse(json);
                  const envelope =
                    raw && typeof raw === 'object' && 'input' in raw ? raw : undefined;
                  if (envelope && 'plan' in envelope) PlanSchema.parse(envelope.plan);
                  const config = EngineInputSchema.parse(envelope ? envelope.input : raw);
                  const modelMap = new Map(
                    (catalog?.models ?? []).map((m) => [m.id, structuredClone(m)]),
                  );
                  for (const m of config.accessible) {
                    const existing = modelMap.get(m.id);
                    if (existing) {
                      const seen = new Set(existing.efforts.map((e) => e.effort));
                      for (const effort of m.efforts)
                        if (!seen.has(effort.effort)) existing.efforts.push(effort);
                    } else {
                      modelMap.set(m.id, ModelSchema.parse(m));
                    }
                  }
                  const nextModels = [...modelMap.values()];
                  const nextConfirmed = Object.fromEntries(
                    config.accessible
                      .filter((m) => m.provisional)
                      .map((m) => [
                        m.id,
                        config.accessible.filter((x) => x.id === m.id).map((x) => x.via),
                      ]),
                  );
                  const nextSelections: Record<string, Selection> = {};
                  for (const id of config.tools) {
                    if (!catalog?.tools.some((t) => t.id === id)) throw new Error('Unknown tool');
                    const visible = config.accessible.filter((m) => m.via === id).map((m) => m.id);
                    nextSelections[id] = {
                      plan: '',
                      hidden: nextModels.filter((m) => !visible.includes(m.id)).map((m) => m.id),
                      scarcity: config.accessible.find((m) => m.via === id)?.scarcity ?? 2,
                      efforts: Object.fromEntries(
                        config.accessible
                          .filter((m) => m.via === id)
                          .map((m) => [m.id, m.efforts.map((e) => e.effort)]),
                      ),
                    };
                  }
                  setCatalog((c) => (c ? { ...c, models: nextModels } : c));
                  setConfirmed(nextConfirmed);
                  setFresh(undefined);
                  setCandidate(undefined);
                  setSelected(nextSelections);
                  setProfile(config.profile);
                  setManual(
                    config.orchestratorOverride
                      ? `${config.orchestratorOverride.model}|${config.orchestratorOverride.via ?? config.accessible.find((m) => m.id === config.orchestratorOverride?.model)?.via}`
                      : '',
                  );
                  setLocks(config.locks ?? {});
                  await makePlan(config);
                  setTargets(undefined);
                  setSettings(false);
                  setStep(3);
                })
              }
            >
              {t('import')}
            </button>
            <p className="muted">{t('exportHint')}</p>
            <div className="button-row">
              <button
                disabled={!accessible.length || busy || !!fresh}
                onClick={() =>
                  void perform(async () => {
                    const config = input();
                    const exported = await makePlan(config);
                    await api.copy(
                      JSON.stringify(
                        { version: 1, input: config, plan: exported, tools: config.tools },
                        null,
                        2,
                      ),
                    );
                    setMessage('copied');
                  })
                }
              >
                {t('exportPlan')}
              </button>
              <button
                disabled={!plan || busy || !!fresh}
                onClick={() =>
                  void perform(async () => {
                    if (!plan) await api.plan(input());
                    const result = await api.preview(['agents-md']);
                    const content = result.exports[0]?.content;
                    if (!content) throw new Error('No rules');
                    await api.copy(content);
                    setMessage('copied');
                  })
                }
              >
                {t('exportRules')}
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="content">
              <p className="eyebrow">{step === 0 ? t('welcomeNote') : t(stepKeys[step]!)}</p>
              <h1 ref={heading} tabIndex={-1}>
                {t(titles[step]!)}
              </h1>
              <p className="intro">{t(bodies[step]!)}</p>
              {step === 0 && (
                <>
                  <div className="welcome-art" aria-hidden="true">
                    <span className="orbit one" />
                    <span className="orbit two" />
                    <span className="orbit three" />
                    <span className="orbit four" />
                    <span className="orbit five" />
                    <span className="orbit six" />
                    <span className="art-center">
                      <svg viewBox="0 0 1024 1024" width="96" height="96" aria-hidden="true">
                        <rect x="100" y="100" width="824" height="824" rx="190" fill="#2c48b8" />
                        <rect x="330" y="470" width="310" height="84" rx="42" fill="#25c7a2" />
                        <g fill="#fff">
                          <rect x="296" y="286" width="84" height="452" rx="42" />
                          <rect x="296" y="286" width="392" height="84" rx="42" />
                          <rect x="296" y="654" width="392" height="84" rx="42" />
                        </g>
                      </svg>
                    </span>
                  </div>
                  <div className="card consent">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      <strong>{t('refreshConsent')}</strong>
                    </label>
                    <p>{t('consentBody')}</p>
                    <small>{t('data')}</small>
                    <UpdateConsent updates={updates} t={t} />
                  </div>
                  <p className="privacy">{t('privacy')}</p>
                </>
              )}
              {step === 1 && (
                <>
                  <label className="search">
                    <span className="sr-only">{t('search')}</span>
                    <input
                      type="search"
                      placeholder={t('search')}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <div className="tool-grid">
                    {catalog?.tools
                      .filter((tool) => tool.name.toLowerCase().includes(search.toLowerCase()))
                      .map((tool) => (
                        <div
                          className={`card tool-card ${selected[tool.id] ? 'selected' : ''}`}
                          key={tool.id}
                        >
                          <label className="check tool-name">
                            <input
                              type="checkbox"
                              checked={!!selected[tool.id]}
                              onChange={() => toggleTool(tool.id)}
                            />
                            <strong>{tool.name}</strong>
                          </label>
                          {!tool.verified && (
                            <small>
                              <Tip text="exportTip">{t('exportOnly')}</Tip>
                            </small>
                          )}
                          {selected[tool.id] && (
                            <div className="tool-options">
                              <label>
                                {t('plan')}
                                <select
                                  value={selected[tool.id]!.plan}
                                  onChange={(e) => {
                                    const sub = catalog.subscriptions.find(
                                      (s) => s.id === e.target.value,
                                    );
                                    setSelected((prev) => ({
                                      ...prev,
                                      [tool.id]: {
                                        plan: e.target.value,
                                        hidden: [],
                                        scarcity: sub?.scarcity ?? 2,
                                      },
                                    }));
                                    invalidate();
                                  }}
                                >
                                  <option value="">{t('custom')}</option>
                                  {catalog.subscriptions
                                    .filter((s) => s.via === tool.id || s.via === 'api-key')
                                    .map((s) => (
                                      <option key={s.id} value={s.id}>
                                        {s.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <label>
                                {t('scarcity')}
                                <select
                                  value={selected[tool.id]!.scarcity}
                                  onChange={(e) => {
                                    setSelected((prev) => ({
                                      ...prev,
                                      [tool.id]: {
                                        ...prev[tool.id]!,
                                        scarcity: Number(e.target.value),
                                      },
                                    }));
                                    invalidate();
                                  }}
                                >
                                  {(['abundant', 'moderate', 'scarce'] as const).map((s, i) => (
                                    <option value={i + 1} key={s}>
                                      {t(s)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <fieldset>
                                <legend>{t('access')}</legend>
                                {catalog.models
                                  .filter((m) => {
                                    const sub = catalog.subscriptions.find(
                                      (s) => s.id === selected[tool.id]!.plan,
                                    );
                                    return (
                                      !m.provisional &&
                                      (!sub ||
                                        sub.models.length === 0 ||
                                        sub.models.some((s) => s.model === m.id))
                                    );
                                  })
                                  .map((m) => (
                                    <label className="check model-check" key={m.id}>
                                      <input
                                        type="checkbox"
                                        checked={!selected[tool.id]!.hidden.includes(m.id)}
                                        onChange={(e) => {
                                          setSelected((prev) => ({
                                            ...prev,
                                            [tool.id]: {
                                              ...prev[tool.id]!,
                                              hidden: e.target.checked
                                                ? prev[tool.id]!.hidden.filter((x) => x !== m.id)
                                                : [...prev[tool.id]!.hidden, m.id],
                                            },
                                          }));
                                          invalidate();
                                        }}
                                      />
                                      {m.name}
                                    </label>
                                  ))}
                              </fieldset>
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                  {catalog?.tools.every(
                    (tool) => !tool.name.toLowerCase().includes(search.toLowerCase()),
                  ) && <p>{t('noTools')}</p>}
                  {!accessible.length && <p className="muted">{t('selectRequired')}</p>}
                </>
              )}
              {step === 2 && (
                <>
                  <div className="profile-grid" role="group" aria-label={t('profile')}>
                    {(['saver', 'balanced', 'quality'] as const).map((p, i) => (
                      <button
                        key={p}
                        className={`card profile ${profile === p ? 'selected' : ''}`}
                        aria-pressed={profile === p}
                        onClick={() => {
                          setProfile(p);
                          setPlan(undefined);
                          setPreview(undefined);
                        }}
                      >
                        <span className="profile-icon" aria-hidden="true">
                          {['◔', '◒', '✧'][i]}
                        </span>
                        <strong>{t(p)}</strong>
                        <span>{t(`${p}Body`)}</span>
                        {p === 'balanced' && <small>{t('recommended')}</small>}
                      </button>
                    ))}
                  </div>
                  <div className="card coordinator">
                    <h2>
                      <Tip text="orchestratorTip">{t('orchestrator')}</Tip>
                    </h2>
                    <div className="button-row">
                      <button aria-pressed={!manual} onClick={() => setManual('')}>
                        {t('auto')}
                      </button>
                      <button
                        aria-pressed={!!manual}
                        onClick={() => {
                          const first = accessible.find(
                            (m) => validEfforts(m, 'orchestrator').length > 0,
                          );
                          setManual(first ? `${first.id}|${first.via}` : '');
                        }}
                      >
                        {t('manual')}
                      </button>
                    </div>
                    {manual && (
                      <label>
                        {t('model')}
                        <select value={manual} onChange={(e) => setManual(e.target.value)}>
                          {choiceOptions('orchestrator')}
                        </select>
                      </label>
                    )}
                  </div>
                </>
              )}
              {step === 3 && plan && (
                <>
                  <div className="crew-grid">
                    {roles.map((role, i) => {
                      const a = plan.assignments[role];
                      return (
                        <article className="card role-card" key={role}>
                          <div className="role-top">
                            <span className={`role-icon role-${i}`} aria-hidden="true">
                              {['↗', '◇', '⌘', '✓', '↻', '◌'][i]}
                            </span>
                            <button
                              className="lock"
                              aria-label={`${t(locks[role] ? 'unlock' : 'lock')} ${t(role)}`}
                              aria-pressed={!!locks[role]}
                              disabled={busy}
                              onClick={() =>
                                void perform(async () => {
                                  const nextLocks = { ...locks };
                                  if (nextLocks[role]) delete nextLocks[role];
                                  else nextLocks[role] = a;
                                  const nextPlan = await makePlan({ ...input(), locks: nextLocks });
                                  setLocks(nextLocks);
                                  setPlan(nextPlan);
                                })
                              }
                            >
                              {t(locks[role] ? 'locked' : 'lock')}
                            </button>
                          </div>
                          <h2>{t(role)}</h2>
                          <p className="role-description">{t(`${role}Body`)}</p>
                          <div className="assignment">
                            <strong>
                              {catalog?.models.find((m) => m.id === a.model)?.name ?? a.model}
                            </strong>
                            <span className="chip">
                              <Tip text="effortTip">{t(a.effort)}</Tip>
                            </span>
                          </div>
                          <p className="why">{explain(a.why[0]!, t)}</p>
                          <details>
                            <summary>{t('details')}</summary>
                            <p>{t('why')}</p>
                            <ul>
                              {a.why.map((why, j) => (
                                <li key={j}>{explain(why, t)}</li>
                              ))}
                            </ul>
                          </details>
                          <details>
                            <summary>
                              <Tip text="fallbackTip" focusable={false}>
                                {t('fallbacks')}
                              </Tip>
                            </summary>
                            {plan.fallbacks[role].length ? (
                              <ol>
                                {plan.fallbacks[role].map((f, j) => (
                                  <li key={j}>
                                    {f.model} · {t(f.effort)}
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <p>{t('noFallback')}</p>
                            )}
                          </details>
                          <button
                            className="change"
                            disabled={busy}
                            onClick={() => setEditing(editing === role ? undefined : role)}
                          >
                            {t('change')}
                          </button>
                          {editing === role && (
                            <div className="role-editor">
                              <label>
                                {t('model')}
                                <select
                                  value={a.model + '|' + a.via}
                                  onChange={(e) =>
                                    void perform(async () => {
                                      const [model, via] = e.target.value.split('|');
                                      const m = accessible.find(
                                        (m) => m.id === model && m.via === via,
                                      )!;
                                      const permitted = validEfforts(m, role);
                                      const nextEffort = (permitted.find(
                                        (x) => x.effort === a.effort,
                                      ) ??
                                        permitted[0] ??
                                        m.efforts[0])!.effort;
                                      const assignment = {
                                        model: m.id,
                                        via: m.via,
                                        effort: nextEffort,
                                        why: [t('manual')],
                                      };
                                      const nextLocks = { ...locks, [role]: assignment };
                                      const nextManual =
                                        role === 'orchestrator' && manual
                                          ? m.id + '|' + m.via
                                          : manual;
                                      await makePlan({
                                        ...input(),
                                        locks: nextLocks,
                                        ...(nextManual
                                          ? {
                                              orchestratorOverride: {
                                                model: nextManual.split('|')[0]!,
                                                via: nextManual.split('|')[1]!,
                                              },
                                            }
                                          : {}),
                                      });
                                      setManual(nextManual);
                                      setLocks(nextLocks);
                                    })
                                  }
                                >
                                  {choiceOptions(role)}
                                </select>
                              </label>
                              <label>
                                <Tip text="effortTip">{t('effort')}</Tip>
                                <select
                                  value={a.effort}
                                  onChange={(e) =>
                                    void perform(async () => {
                                      const effort = accessible
                                        .find((m) => m.id === a.model && m.via === a.via)!
                                        .efforts.find((v) => v.effort === e.target.value)!.effort;
                                      const nextLocks = { ...locks, [role]: { ...a, effort } };
                                      await makePlan({ ...input(), locks: nextLocks });
                                      setLocks(nextLocks);
                                    })
                                  }
                                >
                                  {(accessible.find((m) => m.id === a.model && m.via === a.via)
                                    ? validEfforts(
                                        accessible.find(
                                          (m) => m.id === a.model && m.via === a.via,
                                        )!,
                                        role,
                                      )
                                    : []
                                  ).map((e) => (
                                    <option key={e.effort} value={e.effort}>
                                      {t(e.effort)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                  {plan.warnings.length > 0 && (
                    <details className="notice">
                      <summary>
                        {t('warnings')} ({plan.warnings.length})
                      </summary>
                      <p>{t('familyWarning')}</p>
                      <ul>
                        {plan.warnings.map((w, i) => (
                          <li key={i}>{explain(w, t)}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
              {step === 4 && (
                <>
                  {!applied && recoveries.length > 0 && recoveryList()}
                  {preview?.warnings?.length ? (
                    <p role="status" className="notice">
                      {t('hardlinkWarning')}
                    </p>
                  ) : null}
                  {applied ? (
                    <div className="card success">
                      <div className="success-icon" aria-hidden="true">
                        ✓
                      </div>
                      <h2>{t('ready')}</h2>
                      <p>{t(manifest ? 'success' : 'unchanged')}</p>
                      {manifest && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await revertTransaction(manifest);
                            })
                          }
                        >
                          {t('revert')}
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="card target-list">
                        {Object.keys(selected).map((id) => (
                          <label key={id} className="check">
                            <input
                              type="checkbox"
                              checked={(targets ?? Object.keys(selected)).includes(id)}
                              disabled={busy}
                              onChange={(e) => {
                                const ids = targets ?? Object.keys(selected);
                                setTargets(
                                  e.target.checked ? [...ids, id] : ids.filter((x) => x !== id),
                                );
                                setPreview(undefined);
                              }}
                            />
                            {catalog?.tools.find((t) => t.id === id)?.name}
                          </label>
                        ))}
                      </div>
                      <div className="what">
                        <h2>{t('whatHappens')}</h2>
                        <p>{t('whatBody')}</p>
                        {catalog?.sandbox && <p className="sandbox-note">{t('sandbox')}</p>}
                      </div>
                      <button
                        disabled={busy || !(targets ?? Object.keys(selected)).length}
                        onClick={() =>
                          void perform(async () => {
                            await api.plan(input());
                            setPreview(await api.preview(targets ?? Object.keys(selected)));
                          })
                        }
                      >
                        {t('preview')}
                      </button>
                      {preview && (
                        <div className="preview">
                          <h2>
                            <Tip text="diffTip">{t('diff')}</Tip>
                          </h2>
                          {preview.files.length === 0 && <p>{t('unchanged')}</p>}
                          {preview.files.map((file) => (
                            <details key={file.path} open>
                              <summary>{file.path}</summary>
                              <pre tabIndex={0}>{file.diff}</pre>
                            </details>
                          ))}
                          {preview.exports.map((exp) => (
                            <details key={exp.tool}>
                              <summary>
                                {catalog?.tools.find((t) => t.id === exp.tool)?.name} ·{' '}
                                {t('exportOnly')}
                              </summary>
                              <p>{t('exportTip')}</p>
                              <pre tabIndex={0}>{exp.content}</pre>
                              <button
                                onClick={() =>
                                  void perform(async () => {
                                    await api.copy(exp.content);
                                    setMessage('copied');
                                  })
                                }
                              >
                                {t('copy')}
                              </button>
                            </details>
                          ))}
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() =>
                              void perform(async () => {
                                const result = await api.apply(preview.id);
                                setManifest(result.manifestId);
                                const available = await reloadRecoveries();
                                if (!result.verified) {
                                  setPreview(undefined);
                                  setError(
                                    available.some((m) => m.id === result.manifestId)
                                      ? 'recoveryRequired'
                                      : 'applyRolledBack',
                                  );
                                  return;
                                }
                                setApplied(true);
                              })
                            }
                          >
                            {t('apply')}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
            {!applied && (
              <footer className="wizard-footer">
                <span className="footer-note">{t('noWrites')}</span>
                <div className="button-row">
                  {step > 0 && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setStep((s) => s - 1);
                        setPreview(undefined);
                      }}
                    >
                      {t('back')}
                    </button>
                  )}
                  {step < 4 && (
                    <button
                      className="primary"
                      disabled={busy || !catalog || (step > 0 && !accessible.length)}
                      onClick={() => void next()}
                    >
                      {t('next')} <span aria-hidden="true">→</span>
                    </button>
                  )}
                </div>
              </footer>
            )}
          </>
        )}
        <div className="attribution">{t('data')}</div>
      </main>
    </div>
  );
}
