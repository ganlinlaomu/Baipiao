import { describe, expect, it } from 'vitest';
import { adminHtml, adminScript } from '../src/admin-ui';

describe('admin UI', () => {
  it('ships browser JavaScript that parses', () => {
    expect(() => new Function(adminScript())).not.toThrow();
  });

  it('uses an external same-origin script and no inline handlers', () => {
    const html = adminHtml();
    expect(html).toContain('<script src="/admin.js" defer></script>');
    expect(html).not.toContain('onclick=');
    expect(html).not.toMatch(/<script>([\s\S]*?)<\/script>/);
  });

  it('does not require sessionStorage to be available', () => {
    const script = adminScript();
    expect(script).toContain('safeStorageGet');
    expect(script).toContain('try{');
  });

  it('renders relay read/write activity without inline handlers', () => {
    const html = adminHtml();
    const script = adminScript();
    expect(html).toContain('Relay activity / 读写状态');
    expect(html).toContain('recentWrites');
    expect(script).toContain('/api/admin/stats');
    expect(script).toContain('Write accepted / 写入成功');
    expect(script).toContain('Read REQ / 读取请求');
    expect(html).toContain('Received / 写入时间');
    expect(html).toContain('Event time / 事件时间');
    expect(script).toContain('Legacy / unknown');
  });
});
