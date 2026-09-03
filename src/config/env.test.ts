import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '@appliqation/agent-core/providers';

// The real .env file (this repo's, with real credentials) must never leak
// into these tests — mock dotenv/config as a no-op so process.env is fully
// under this file's control.
vi.mock('dotenv/config', () => ({}));

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_MODEL', 'DEEPSEEK_MODEL', 'GLM_MODEL', 'APPQ_ORIGIN', 'APPQ_API_KEY'];

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

/** config is built once at module load, so a fresh env state needs a fresh module instance. */
async function freshEnv() {
  vi.resetModules();
  return import('./env.js');
}

describe('resolveProvider', () => {
  it('prefers anthropic when multiple API keys are set', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.OPENAI_API_KEY = 'b';
    process.env.DEEPSEEK_API_KEY = 'c';
    process.env.GLM_API_KEY = 'd';
    const { resolveProvider } = await freshEnv();
    expect(resolveProvider()).toBe('anthropic');
  });

  it('falls back to openai when anthropic is not set', async () => {
    process.env.OPENAI_API_KEY = 'b';
    process.env.DEEPSEEK_API_KEY = 'c';
    const { resolveProvider } = await freshEnv();
    expect(resolveProvider()).toBe('openai');
  });

  it('falls back to deepseek when only its key is set', async () => {
    process.env.DEEPSEEK_API_KEY = 'c';
    const { resolveProvider } = await freshEnv();
    expect(resolveProvider()).toBe('deepseek');
  });

  it('falls back to glm when only its key is set', async () => {
    process.env.GLM_API_KEY = 'd';
    const { resolveProvider } = await freshEnv();
    expect(resolveProvider()).toBe('glm');
  });

  it('throws when no provider is configured', async () => {
    const { resolveProvider } = await freshEnv();
    expect(() => resolveProvider()).toThrow(/ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or GLM_API_KEY/);
  });
});

describe('resolveModel', () => {
  it('anthropic: uses the provider default when unset', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    const { resolveModel } = await freshEnv();
    expect(resolveModel()).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('anthropic: an explicit ANTHROPIC_MODEL wins', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
    const { resolveModel } = await freshEnv();
    expect(resolveModel()).toBe('claude-haiku-4-5-20251001');
  });

  it('openai: uses the provider default when unset', async () => {
    process.env.OPENAI_API_KEY = 'b';
    const { resolveModel } = await freshEnv();
    expect(resolveModel()).toBe(DEFAULT_OPENAI_MODEL);
  });

  it('deepseek: has no default — throws a clear, actionable error when DEEPSEEK_MODEL is unset', async () => {
    process.env.DEEPSEEK_API_KEY = 'c';
    const { resolveModel } = await freshEnv();
    expect(() => resolveModel()).toThrow(/DEEPSEEK_MODEL is required/);
  });

  it('deepseek: uses DEEPSEEK_MODEL when set', async () => {
    process.env.DEEPSEEK_API_KEY = 'c';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    const { resolveModel } = await freshEnv();
    expect(resolveModel()).toBe('deepseek-chat');
  });

  it('glm: has no default — throws a clear, actionable error when GLM_MODEL is unset', async () => {
    process.env.GLM_API_KEY = 'd';
    const { resolveModel } = await freshEnv();
    expect(() => resolveModel()).toThrow(/GLM_MODEL is required/);
  });

  it('glm: uses GLM_MODEL when set', async () => {
    process.env.GLM_API_KEY = 'd';
    process.env.GLM_MODEL = 'glm-4.6';
    const { resolveModel } = await freshEnv();
    expect(resolveModel()).toBe('glm-4.6');
  });
});

describe('deepseek/glm base URLs', () => {
  it('default to the documented public endpoints when not overridden', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    const { config } = await freshEnv();
    expect(config.deepseekBaseUrl).toBe('https://api.deepseek.com');
    expect(config.glmBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('respect explicit DEEPSEEK_BASE_URL/GLM_BASE_URL overrides', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.DEEPSEEK_BASE_URL = 'https://internal-proxy.example/deepseek';
    process.env.GLM_BASE_URL = 'https://internal-proxy.example/glm';
    const { config } = await freshEnv();
    expect(config.deepseekBaseUrl).toBe('https://internal-proxy.example/deepseek');
    expect(config.glmBaseUrl).toBe('https://internal-proxy.example/glm');
  });
});
