// @vitest-environment jsdom
/**
 * The file picker.
 *
 * There is no permanent sidebar, so this modal is the only way to reach a file by
 * name. What it offers is filtered by kind, which is what keeps `Add file` from
 * putting something on the canvas that no node can render.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

import { FileTree } from '@/workspace/FileTree';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { cleanup, press, render, settle, type } from './support/render';
import { resetStores } from './support/stores';

const picked: Array<string | null> = [];

const rows = (host: ParentNode) =>
  [...host.querySelectorAll('.file-row')].map((row) => row.querySelector('.path')?.textContent);

const open = async (kinds: Parameters<typeof FileTree>[0]['kinds']) => {
  const tree = await render(<FileTree title="Add file to canvas" kinds={kinds} onPick={(path) => picked.push(path)} />);
  await settle();
  return tree;
};

beforeEach(async () => {
  resetStores();
  backend.reset();
  picked.length = 0;
  await openFixtureWorkspace();
  // Through the store, so the picker's own refresh has a workspace to list.
  await useWorkspaceStore.getState().open('/workspace');
});

afterEach(async () => {
  await cleanup();
});

describe('what it offers', () => {
  it('lists every file of the kinds asked for, with its path', async () => {
    const tree = await open(['image', 'pdf']);

    expect(rows(tree.host)?.sort()).toEqual([
      'Attachments/doc.pdf',
      'Attachments/square.png',
      'Attachments/wide.png',
    ]);
  });

  it('offers nothing of a kind that was not asked for', async () => {
    const tree = await open(['canvas']);

    expect(rows(tree.host)).toEqual(['Canvases/Main.canvas']);
  });

  it('says so when the workspace holds nothing suitable', async () => {
    const tree = await open(['video']);
    // The fixture workspace has video, so ask for something it has none of.
    await settle();
    expect(rows(tree.host)).toContain('Attachments/tiny.mp4');

    backend.files.delete('Attachments/tiny.mp4');
    backend.files.delete('Attachments/tiny.mkv');
    await useWorkspaceStore.getState().refreshTree();
    await settle();

    expect(tree.text()).toContain('No matching file in this workspace');
  });

  it('filters by anything in the path, not just the name', async () => {
    const tree = await open(['markdown', 'canvas', 'image', 'pdf', 'video', 'audio', 'text']);

    await type(tree.find<HTMLInputElement>('input'), 'canvases');

    expect(rows(tree.host)).toEqual(['Canvases/Main.canvas']);
  });
});

describe('choosing', () => {
  it('answers with the path when a row is clicked', async () => {
    const tree = await open(['canvas']);

    tree.find('.file-row').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();

    expect(picked).toEqual(['Canvases/Main.canvas']);
  });

  it('answers with the highlighted row on Enter', async () => {
    const tree = await open(['image']);
    const input = tree.find<HTMLInputElement>('input');
    await type(input, 'wide');

    await press(input, 'Enter');

    expect(picked).toEqual(['Attachments/wide.png']);
  });

  it('answers with nothing on Escape', async () => {
    const tree = await open(['image']);

    await press(tree.find('input'), 'Escape');

    // Nothing chosen is different from nothing offered, and the caller is told.
    expect(picked).toEqual([null]);
  });

  it('answers nothing at all when there is nothing to choose', async () => {
    const tree = await open(['image']);
    const input = tree.find<HTMLInputElement>('input');
    await type(input, 'nothing matches this');

    await press(input, 'Enter');

    expect(picked).toEqual([]);
  });
});
