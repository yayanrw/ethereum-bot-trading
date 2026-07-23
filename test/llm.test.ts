import { afterEach, describe, expect, test } from 'bun:test';
import { selectProvider, stripFences } from '../src/core/llm.ts';

const prevProvider = process.env.LLM_PROVIDER;
const prevKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  restore('LLM_PROVIDER', prevProvider);
  restore('ANTHROPIC_API_KEY', prevKey);
});

function restore(key: string, val: string | undefined) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

describe('provider selection', () => {
  test('explicit LLM_PROVIDER wins over everything', () => {
    process.env.LLM_PROVIDER = 'claude-code';
    process.env.ANTHROPIC_API_KEY = 'sk-whatever';
    expect(selectProvider()).toBe('claude-code');
  });

  test('auto: api when a key is present', () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = 'sk-whatever';
    expect(selectProvider()).toBe('api');
  });

  test('auto: claude-code when no key', () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    expect(selectProvider()).toBe('claude-code');
  });

  test('a garbage LLM_PROVIDER falls through to auto', () => {
    process.env.LLM_PROVIDER = 'nonsense';
    delete process.env.ANTHROPIC_API_KEY;
    expect(selectProvider()).toBe('claude-code');
  });
});

describe('fence stripping', () => {
  test('peels a ```json fence', () => {
    expect(stripFences('```json\n{"rules":[]}\n```')).toBe('{"rules":[]}');
  });

  test('peels a bare ``` fence', () => {
    expect(stripFences('```\n{"rules":[]}\n```')).toBe('{"rules":[]}');
  });

  test('leaves unfenced JSON untouched', () => {
    expect(stripFences('  {"rules":[]}  ')).toBe('{"rules":[]}');
  });
});
