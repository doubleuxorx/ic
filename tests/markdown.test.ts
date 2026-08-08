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

  it('renders task list items as boxes, ticked or not', () => {
    const host = parse('- [ ] open\n- [x] done\n- [X] also done\n- plain');
    const items = [...host.querySelectorAll('li')];
    expect(items).toHaveLength(4);

    expect(items.map((item) => item.querySelector('.task-box')?.className)).toEqual([
      'task-box',
      'task-box checked',
      'task-box checked',
      undefined,
    ]);
    expect(items.map((item) => item.className)).toEqual([
      'task-item',
      'task-item',
      'task-item',
      '',
    ]);
    // The marker is consumed, not left in the text beside the box.
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'open',
      'done',
      'also done',
      'plain',
    ]);
    expect(items[0]?.querySelector('.task-box')?.getAttribute('aria-checked')).toBe('false');
    expect(items[1]?.querySelector('.task-box')?.getAttribute('aria-checked')).toBe('true');
  });

  it('renders task items with inline markup and an empty one', () => {
    const host = parse('- [ ] **bold** and [a link](https://example.org)\n- [x]\n- [y] not a task');
    const items = [...host.querySelectorAll('li')];
    expect(items[0]?.querySelector('strong')?.textContent).toBe('bold');
    expect(items[0]?.querySelector('.md-link')?.textContent).toBe('a link');
    expect(items[1]?.querySelector('.task-box')?.className).toBe('task-box checked');
    expect(items[1]?.textContent?.trim()).toBe('');
    // Only `[ ]`, `[x]` and `[X]` are markers; anything else stays text.
    expect(items[2]?.querySelector('.task-box')).toBeNull();
    expect(items[2]?.textContent?.trim()).toBe('[y] not a task');
  });

  it('takes a task marker only at the start of a list item', () => {
    const host = parse('- text [ ] more\n\nA paragraph [x] with brackets.');
    expect(host.querySelectorAll('.task-box')).toHaveLength(0);
    expect(host.querySelector('li')?.textContent).toBe('text [ ] more');
    expect(host.querySelector('p')?.textContent).toBe('A paragraph [x] with brackets.');
  });

  it('extracts heading sections named by a subpath', () => {
    const note = '# One\ntext one\n\n## Two\ntext two\n\n# Three\ntext three';
    expect(sliceSubpath(note, '#Two')).toBe('## Two\ntext two\n');
    expect(sliceSubpath(note, undefined)).toBe(note);
    expect(sliceSubpath(note, '#Missing')).toBe(note);
  });
});
