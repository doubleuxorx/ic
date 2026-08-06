// @vitest-environment jsdom
/**
 * Markdown as a node renders it, and links as a click meets them.
 *
 * `tests/markdown.test.ts` asserts against the sanitizer's output. This asserts
 * the same rules where they actually protect anything — inside a mounted preview,
 * with a real click — because sanitized HTML that is then handed to a live `href`
 * would be no safer than not sanitizing it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

import { useUiStore } from '@/app/ui-store';
import { MarkdownPreview } from '@/canvas/node-types/MarkdownPreview';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { cleanup, click, render, settle } from './support/render';
import { resetStores } from './support/stores';

const answer = async (value: boolean): Promise<void> => {
  const modal = useUiStore.getState().modal;
  if (!modal) throw new Error('nothing was asked');
  (modal.resolve as (value: boolean) => void)(value);
  await settle();
};

beforeEach(async () => {
  resetStores();
  backend.reset();
  await openFixtureWorkspace();
});

afterEach(async () => {
  await cleanup();
});

describe('what a preview renders', () => {
  it('renders ordinary Markdown', async () => {
    const preview = await render(
      <MarkdownPreview source={'# Title\n\nA **bold** word.\n\n- one\n- two\n'} />,
    );

    expect(preview.find('h1').textContent).toBe('Title');
    expect(preview.find('strong').textContent).toBe('bold');
    expect(preview.host.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders no script, style or event handler, whatever the file contains', async () => {
    const preview = await render(
      <MarkdownPreview
        source={
          '<script>window.stolen = 1</script>\n\n' +
          '<img src=x onerror="window.stolen = 2">\n\n' +
          '<style>body { display: none }</style>\n\n' +
          '<iframe src="https://example.org"></iframe>\n\n' +
          '<div onclick="window.stolen = 3">text</div>\n'
        }
      />,
    );

    // Raw HTML is never parsed, so this arrives as text on the page rather than
    // as elements: there is nothing to strip because nothing was ever built.
    expect(preview.host.querySelector('script')).toBeNull();
    expect(preview.host.querySelector('style')).toBeNull();
    expect(preview.host.querySelector('iframe')).toBeNull();
    expect(preview.host.querySelector('img')).toBeNull();
    expect(preview.host.querySelector('div[onclick]')).toBeNull();
    for (const element of preview.host.querySelectorAll('*')) {
      const handlers = [...element.attributes].filter((attribute) =>
        attribute.name.startsWith('on'),
      );
      expect(handlers).toEqual([]);
    }
    expect((window as { stolen?: number }).stolen).toBeUndefined();
  });

  it('resolves a relative image against the workspace and drops a remote one', async () => {
    const preview = await render(
      <MarkdownPreview
        source={'![local](square.png)\n\n![remote](https://example.org/tracker.png)\n'}
        baseDirectory="Attachments"
      />,
    );

    const images = [...preview.host.querySelectorAll('img')];
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute('src')).toBe('ic://localhost/Attachments/square.png');
    // The remote one keeps its place in the text but has nothing to fetch, so
    // opening a note cannot tell anyone that it was opened.
    expect(images[1]?.hasAttribute('src')).toBe(false);
  });
});

describe('a link inside a note', () => {
  it('is inert: the href is not there to be followed', async () => {
    const preview = await render(
      <MarkdownPreview source={'[a link](https://example.org/page)\n'} />,
    );

    const link = preview.find('a');
    expect(link.getAttribute('href')).toBeNull();
    expect(link.getAttribute('data-href')).toBe('https://example.org/page');
  });

  it('asks before opening, showing the whole address', async () => {
    const preview = await render(
      <MarkdownPreview source={'[a link](https://example.org/page?a=1)\n'} />,
    );

    await click(preview.find('a'));

    const modal = useUiStore.getState().modal;
    expect(modal?.kind).toBe('confirm');
    // The address is what the user is deciding about, so it is what they see.
    expect((modal as { message: string }).message).toBe('https://example.org/page?a=1');
    expect(backend.callsTo('external_open_url')).toEqual([]);

    await answer(true);
    expect(backend.callsTo('external_open_url')).toEqual([
      { url: 'https://example.org/page?a=1' },
    ]);
  });

  it('opens nothing when the user declines', async () => {
    const preview = await render(<MarkdownPreview source={'[a link](https://example.org)\n'} />);

    await click(preview.find('a'));
    await answer(false);

    expect(backend.callsTo('external_open_url')).toEqual([]);
  });

  it('never reaches the opener with a scheme of its own choosing', async () => {
    const preview = await render(
      <MarkdownPreview
        source={
          '[script](javascript:window.stolen=1)\n\n' +
          '[data](data:text/html,<script>1</script>)\n\n' +
          '[file](file:///etc/passwd)\n'
        }
      />,
    );

    for (const link of preview.host.querySelectorAll('a')) {
      // A scheme the application will not open is not offered as a link at all.
      expect(link.getAttribute('href')).toBeNull();
      expect(link.getAttribute('data-href')).toBeNull();
    }
    expect((window as { stolen?: number }).stolen).toBeUndefined();
  });
});
