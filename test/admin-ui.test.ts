import { describe, expect, it } from 'vitest';
import { adminHtml } from '../src/admin-ui';

describe('admin UI', () => {
  it('ships browser JavaScript that parses', () => {
    const html = adminHtml();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(() => new Function(match?.[1] ?? '')).not.toThrow();
  });

  it('does not rely on inline onclick handlers', () => {
    expect(adminHtml()).not.toContain('onclick=');
  });
});
