// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/workspace/workspace-store', () => ({
  fileUrl: (relativePath: string) => `ic://localhost/${relativePath}`,
}));

const { renderMarkdown, sliceSubpath } = await import('@/editor/markdown-renderer');

/** Assertions run against the parsed DOM: escaped text is inert by definition. */
const parse = (markdown: string, base = ''): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(markdown, base);
  return host;
};

describe('markdown rendering', () => {
  it('renders ordinary markdown', () => {
    const host = parse('# Title\n\nSome **bold** text.');
    expect(host.querySelector('h1')?.textContent).toBe('Title');
    expect(host.querySelector('strong')?.textContent).toBe('bold');
  });

  it('produces no executable element or attribute from hostile input', () => {
    const host = parse(
      [
        '<script>window.stolen = 1</script>',
        '<img src=x onerror="window.stolen = 1">',
        '<iframe src="https://example.org"></iframe>',
        '<svg onload="window.stolen = 1"></svg>',
        '<style>body{display:none}</style>',
        '<object data="x"></object>',
        '<form action="/x"><input name="a"></form>',
      ].join('\n\n'),
    );

    for (const tag of ['script', 'iframe', 'svg', 'style', 'object', 'embed', 'form', 'input']) {
      expect(host.querySelectorAll(tag)).toHaveLength(0);
    }
    for (const element of host.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(attribute.name).not.toBe('style');
      }
    }
    // Raw HTML survives only as visible text.
    expect(host.textContent).toContain('<script>');
  });

  it('renders links inert, keeping the address for deliberate opening', () => {
    const host = parse('[example](https://example.org/page)');
    const anchor = host.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(anchor?.getAttribute('data-href')).toBe('https://example.org/page');
    expect(anchor?.className).toBe('md-link');
  });

  it('produces no link at all for unsupported schemes', () => {
    const host = parse('[f](file:///etc/passwd) [j](javascript:window.stolen=1)');
    expect(host.querySelectorAll('a')).toHaveLength(0);
    expect(host.querySelectorAll('[data-href]')).toHaveLength(0);
  });

  it('resolves relative images through the local protocol and blocks remote ones', () => {
    expect(parse('![alt](image.png)', 'Notes').querySelector('img')?.getAttribute('src')).toBe(
      'ic://localhost/Notes/image.png',
    );
    expect(
      parse('![alt](../Attachments/image.png)', 'Notes/Sub')
        .querySelector('img')
        ?.getAttribute('src'),
    ).toBe('ic://localhost/Notes/Attachments/image.png');

    const remote = parse('![alt](https://example.org/tracker.png)');
    expect(remote.querySelector('img')?.hasAttribute('src')).toBe(false);
  });

  it('extracts heading sections named by a subpath', () => {
    const note = '# One\ntext one\n\n## Two\ntext two\n\n# Three\ntext three';
    expect(sliceSubpath(note, '#Two')).toBe('## Two\ntext two\n');
    expect(sliceSubpath(note, undefined)).toBe(note);
    expect(sliceSubpath(note, '#Missing')).toBe(note);
  });
});
