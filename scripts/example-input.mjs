import { models } from '../dist/core/catalog.js';
// Example only: users must confirm actual model/effort access in their own tools.
console.log(
  JSON.stringify(
    {
      accessible: models
        .filter((model) =>
          ['claude-opus-5-5', 'gpt-6-1-sol', 'gemini-3-8-flash'].includes(model.id),
        )
        .map((model) => ({
          ...model,
          via:
            model.family === 'claude'
              ? 'claude-code'
              : model.family === 'gpt'
                ? 'codex-cli'
                : 'gemini-cli',
          scarcity: model.family === 'claude' ? 3 : model.family === 'gpt' ? 2 : 1,
        })),
      profile: 'balanced',
      tools: ['claude-code', 'codex-cli', 'gemini-cli'],
    },
    null,
    2,
  ),
);
