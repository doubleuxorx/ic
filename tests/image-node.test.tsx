// @vitest-environment jsdom
/**
 * Image nodes: which file a node actually loads, and what it says when it cannot.
 *
 * A large image is expected to render from a cached thumbnail, so a canvas full of
 * photographs never decodes them at full resolution. That is the difference
 * between a responsive canvas and an unusable one, and it is invisible on screen —
 * the picture looks the same either way — so it is worth asserting here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

import { ImageNode } from '@/media/ImageNode';
import { useMediaStore } from '@/media/media-view-store';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { cleanup, fire, render, settle } from './support/render';
import { resetStores } from './support/stores';

const source = (node: { find: (selector: string) => Element }) =>
  node.find('img').getAttribute('src');

beforeEach(async () => {
  resetStores();
  backend.reset();
  await openFixtureWorkspace();
});

afterEach(async () => {
  await cleanup();
});

describe('what a node loads', () => {
  it('renders a small image directly, since a thumbnail would gain nothing', async () => {
    const node = await render(
      <ImageNode nodeId="n1" relativePath="Attachments/square.png" active alt="Square" />,
    );
    await settle();

    expect(source(node)).toBe('ic://localhost/Attachments/square.png');
    expect(node.find('img').getAttribute('alt')).toBe('Square');
  });

  it('renders a large image from its thumbnail', async () => {
    const node = await render(
      <ImageNode nodeId="n1" relativePath="Attachments/wide.png" active alt="Wide" />,
    );
    await settle();

    expect(source(node)).toMatch(/^ic:\/\/localhost\/\.app\/thumbnails\//);
    expect(backend.callsTo('thumbnail_request')).toEqual([
      { relativePath: 'Attachments/wide.png' },
    ]);
  });

  /** Original size is the one case that needs the real file. */
  it('loads the full file when the node is showing it at original size', async () => {
    useMediaStore.getState().setFit('n1', 'original');
    const node = await render(
      <ImageNode nodeId="n1" relativePath="Attachments/wide.png" active alt="Wide" />,
    );
    await settle();

    expect(source(node)).toBe('ic://localhost/Attachments/wide.png');
    expect(backend.callsTo('thumbnail_request')).toEqual([]);
  });

  it('goes back to the thumbnail when the fit mode changes back', async () => {
    useMediaStore.getState().setFit('n1', 'original');
    const node = await render(
      <ImageNode nodeId="n1" relativePath="Attachments/wide.png" active alt="Wide" />,
    );
    await settle();

    useMediaStore.getState().setFit('n1', 'fit');
    await settle();

    expect(source(node)).toMatch(/\.app\/thumbnails\//);
    expect(node.find('img').className).toContain('fit');
  });

  it('encodes an awkward name rather than building a broken URL', async () => {
    backend.write('Attachments/a b#c.png', 'pretend png', { width: 10, height: 10 });
    const node = await render(
      <ImageNode nodeId="n1" relativePath="Attachments/a b#c.png" active alt="Odd" />,
    );
    await settle();

    expect(source(node)).toBe('ic://localhost/Attachments/a%20b%23c.png');
  });
});

describe('when it cannot be shown', () => {
  /** Thumbnailing can fail for a format the webview still displays. */
  it('falls back to the original file when thumbnailing fails', async () => {
    backend.refuse.set(
      'Attachments/wide.png',
      'file type is not supported: Attachments/wide.png',
    );
    const node = await render(
      <ImageNode nodeId="n1" relativePath="Attachments/wide.png" active alt="Wide" />,
    );
    await settle();

    expect(source(node)).toBe('ic://localhost/Attachments/wide.png');
  });

  it('says so on the node when the image itself will not display', async () => {
    const node = await render(
      <ImageNode nodeId="n1" relativePath="Attachments/square.png" active alt="Square" />,
    );
    await settle();

    await fire(node.find('img'), new Event('error'));

    expect(node.text()).toContain('could not be displayed');
    expect(node.query('img')).toBeNull();
  });

  it('does not report a broken image as a crash', async () => {
    await import('@/boot-guard');
    const node = await render(
      <ImageNode nodeId="n1" relativePath="Attachments/square.png" active alt="Square" />,
    );
    await settle();

    await fire(node.find('img'), new Event('error'));

    expect(document.getElementById('fatal')).toBeNull();
  });
});
