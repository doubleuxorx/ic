// @vitest-environment jsdom
/**
 * The canvas document: mutation, undo, autosave and disagreement with disk.
 *
 * This is the layer that decides what ends up in a `.canvas` file, so every test
 * here checks the document itself rather than anything on screen. The conflict
 * cases matter most: a canvas is the one file a user can also edit in another
 * application, and losing either side of that is unrecoverable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

import { AUTOSAVE_DELAY_MS, useCanvasStore } from '@/canvas/canvas-store';
import type { CanvasEdge, CanvasNode } from '@/shared/json-canvas';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { resetStores } from './support/stores';

const canvas = () => useCanvasStore.getState();
const onDisk = () => JSON.parse(backend.contents('Canvases/Main.canvas'));

const text = (id: string, over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: 'text', text: id, x: 0, y: 0, width: 200, height: 100, ...over }) as CanvasNode;

const open = async (): Promise<void> => {
  await useWorkspaceStore.getState().loadFacts();
  await useWorkspaceStore.getState().open('/workspace');
  await canvas().load('Canvases/Main.canvas');
};

beforeEach(async () => {
  resetStores();
  backend.reset();
  await openFixtureWorkspace();
  await useWorkspaceStore.getState().close();
  vi.useFakeTimers();
  await open();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('what reaches the file', () => {
  it('writes exactly the document and nothing about the session', async () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
    canvas().setSelection(['a']);
    canvas().setActiveNode('a');
    canvas().setViewport({ x: -40, y: 12, zoom: 1.75 });

    await canvas().save({ force: true });

    // Selection, the active editor and the viewport are interaction state.
    expect(Object.keys(onDisk())).toEqual(['nodes', 'edges']);
    expect(onDisk().nodes).toHaveLength(1);
    expect(onDisk().nodes[0]).not.toHaveProperty('selected');
  });

  it('keeps fields another application put there', async () => {
    backend.write(
      'Canvases/Main.canvas',
      JSON.stringify({
        nodes: [{ ...text('a'), theirField: { nested: true } }],
        edges: [],
        theirTopLevel: 'kept',
      }),
    );
    await canvas().load('Canvases/Main.canvas');

    canvas().mutate({ type: 'patch-nodes', patches: [{ id: 'a', changes: { x: 99 } }] });
    await canvas().save({ force: true });

    expect(onDisk().theirTopLevel).toBe('kept');
    expect(onDisk().nodes[0].theirField).toEqual({ nested: true });
    expect(onDisk().nodes[0].x).toBe(99);
  });

  it('saves by itself shortly after a change', async () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
    expect(canvas().dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);

    expect(canvas().dirty).toBe(false);
    expect(onDisk().nodes).toHaveLength(1);
  });

  it('does not write when nothing changed', async () => {
    await canvas().save();
    expect(backend.callsTo('document_write')).toEqual([]);
  });

  it('presents the revision it last saw, and adopts the one it is given', async () => {
    const first = canvas().revision;
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
    await canvas().save({ force: true });

    const write = backend.callsTo('document_write')[0] as { expectedRevision: string };
    expect(write.expectedRevision).toBe(first);
    expect(canvas().revision).not.toBe(first);

    // The next write must present the new one, or Rust would refuse it.
    canvas().mutate({ type: 'insert-nodes', nodes: [text('b')] });
    await canvas().save({ force: true });
    expect(onDisk().nodes).toHaveLength(2);
  });
});

describe('undo', () => {
  it('inverts every kind of change', async () => {
    const cases: Array<{ what: string; op: Parameters<ReturnType<typeof canvas>['mutate']>[0] }> = [
      { what: 'insert', op: { type: 'insert-nodes', nodes: [text('new')] } },
      { what: 'delete', op: { type: 'delete-nodes', ids: ['a'] } },
      { what: 'patch', op: { type: 'patch-nodes', patches: [{ id: 'a', changes: { x: 500 } }] } },
      { what: 'reorder', op: { type: 'reorder-nodes', order: ['b', 'a'] } },
      { what: 'insert edge', op: { type: 'insert-edges', edges: [{ id: 'e2', fromNode: 'a', toNode: 'b' } as CanvasEdge] } },
      { what: 'delete edge', op: { type: 'delete-edges', ids: ['e1'] } },
      { what: 'patch edge', op: { type: 'patch-edges', patches: [{ id: 'e1', changes: { label: 'why' } }] } },
    ];

    for (const { what, op } of cases) {
      useCanvasStore.setState({
        document: {
          nodes: [text('a'), text('b', { x: 400 })],
          edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' } as CanvasEdge],
        },
      });
      const before = JSON.stringify(canvas().document);

      canvas().mutate(op);
      expect(JSON.stringify(canvas().document), what).not.toBe(before);
      canvas().undo();

      expect(JSON.stringify(canvas().document), what).toBe(before);
    }
  });

  it('redoes what it undid, and forgets the redo once something else happens', () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
    canvas().undo();
    canvas().redo();
    expect(canvas().document.nodes).toHaveLength(1);

    canvas().undo();
    canvas().mutate({ type: 'insert-nodes', nodes: [text('b')] });
    expect(canvas().history.future).toEqual([]);
    canvas().redo();
    expect(canvas().document.nodes.map((node) => node.id)).toEqual(['b']);
  });

  it('does nothing when there is nothing to undo', () => {
    const before = canvas().document;
    canvas().undo();
    canvas().redo();
    expect(canvas().document).toBe(before);
  });

  /** Typing is one edit per keystroke, but one step for the user. */
  it('coalesces consecutive edits that share a merge key', () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a', { text: '' })] });
    for (const value of ['h', 'he', 'hel', 'hell', 'hello']) {
      canvas().mutate(
        { type: 'patch-nodes', patches: [{ id: 'a', changes: { text: value } }] },
        { mergeKey: 'text:a' },
      );
    }

    expect(canvas().history.past).toHaveLength(2);
    canvas().undo();
    expect((canvas().document.nodes[0] as { text: string }).text).toBe('');
  });
});

describe('when the file changed underneath', () => {
  it('adopts the new version when there is nothing local to lose', async () => {
    backend.write(
      'Canvases/Main.canvas',
      JSON.stringify({ nodes: [text('elsewhere')], edges: [] }),
    );

    await canvas().onExternalChange(['Canvases/Main.canvas']);

    expect(canvas().document.nodes.map((node) => node.id)).toEqual(['elsewhere']);
    expect(canvas().conflict).toBeNull();
    // Adopting a different document means the old undo stack is meaningless.
    expect(canvas().history.past).toEqual([]);
  });

  it('asks instead of choosing when both sides changed', async () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('mine')] });
    backend.write('Canvases/Main.canvas', JSON.stringify({ nodes: [text('theirs')], edges: [] }));

    await canvas().onExternalChange(['Canvases/Main.canvas']);

    expect(canvas().conflict?.relativePath).toBe('Canvases/Main.canvas');
    expect(canvas().conflict?.diskContents).toContain('theirs');
    // Neither side has been overwritten while the question is open.
    expect(canvas().document.nodes.map((node) => node.id)).toEqual(['mine']);
    expect(onDisk().nodes[0].id).toBe('theirs');
  });

  it('ignores a change to some other file', async () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
    await canvas().onExternalChange(['Notes/note.md']);
    expect(canvas().conflict).toBeNull();
  });

  it('writes nothing at all while a conflict is unresolved', async () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('mine')] });
    backend.write('Canvases/Main.canvas', JSON.stringify({ nodes: [text('theirs')], edges: [] }));
    await canvas().onExternalChange(['Canvases/Main.canvas']);
    backend.calls = [];

    canvas().mutate({ type: 'insert-nodes', nodes: [text('more')] });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);

    expect(backend.callsTo('document_write')).toEqual([]);
  });

  it('keeps mine by writing over the version on disk when asked', async () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('mine')] });
    backend.write('Canvases/Main.canvas', JSON.stringify({ nodes: [text('theirs')], edges: [] }));
    await canvas().onExternalChange(['Canvases/Main.canvas']);

    await canvas().resolveConflict('keep-mine');

    expect(onDisk().nodes[0].id).toBe('mine');
    expect(canvas().conflict).toBeNull();
    expect(canvas().dirty).toBe(false);
  });

  it('takes the version on disk when asked, leaving it as it is', async () => {
    canvas().mutate({ type: 'insert-nodes', nodes: [text('mine')] });
    backend.write('Canvases/Main.canvas', JSON.stringify({ nodes: [text('theirs')], edges: [] }));
    await canvas().onExternalChange(['Canvases/Main.canvas']);

    await canvas().resolveConflict('take-disk');

    expect(canvas().document.nodes.map((node) => node.id)).toEqual(['theirs']);
    expect(canvas().conflict).toBeNull();
    expect(canvas().dirty).toBe(false);
    expect(backend.callsTo('document_write')).toEqual([]);
  });

  /** A refused write that is not a conflict must still be visible. */
  it('surfaces any other failure rather than swallowing it', async () => {
    backend.refuse.set('Canvases/Main.canvas', 'io error: disk full');
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });

    await canvas().save({ force: true });

    expect(canvas().lastError).toBe('io error: disk full');
    expect(canvas().dirty).toBe(true);
  });
});

describe('the viewport', () => {
  it('is remembered per canvas, and restored on load', async () => {
    canvas().setViewport({ x: -100, y: -50, zoom: 2 });
    await vi.advanceTimersByTimeAsync(2000);

    expect(backend.settings.viewports['Canvases/Main.canvas']).toEqual({
      x: -100,
      y: -50,
      zoom: 2,
    });

    await canvas().load('Canvases/Main.canvas');
    expect(canvas().viewport).toEqual({ x: -100, y: -50, zoom: 2 });
  });

  it('starts a canvas nobody has opened at the origin', async () => {
    backend.write('Canvases/Fresh.canvas', JSON.stringify({ nodes: [], edges: [] }));
    await canvas().load('Canvases/Fresh.canvas');
    expect(canvas().viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe('selection', () => {
  /**
   * The canvas view owns the selection while the user is interacting; a mirror
   * that also drives its source oscillates forever whenever the two disagree.
   */
  it('records what the view reports without asking for it back', () => {
    canvas().reportSelection(['a'], ['e1']);
    expect(canvas().selection).toEqual(['a']);
    expect(canvas().selectionRequest).toBeNull();
  });

  it('raises a request only when something asks for a selection', () => {
    canvas().setSelection(['a', 'b']);
    expect(canvas().selectionRequest).toEqual({ ids: ['a', 'b'], edgeIds: [] });

    const first = canvas().selectionRequest;
    canvas().reportSelection(['a', 'b'], []);
    // Reporting the same thing back must not look like a new request.
    expect(canvas().selectionRequest).toBe(first);
  });
});
