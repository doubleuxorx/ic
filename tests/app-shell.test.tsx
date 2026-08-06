// @vitest-environment jsdom
/**
 * The shell: keyboard routing, files dropped on the window, changes on disk, and
 * the close button.
 *
 * All four only exist inside the mounted application — the first as a window
 * listener, the rest as Tauri events — so none of them can be reached from a test
 * any other way. Losing unsaved work when a window closes is the kind of failure
 * that is discovered by a user, once, expensively.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

vi.mock('@tauri-apps/api/event', async () => {
  const { listen } = await import('./support/fake-events');
  return { listen };
});

vi.mock('@tauri-apps/api/window', async () => {
  const { getCurrentWindow } = await import('./support/fake-events');
  return { getCurrentWindow };
});

const chooseInDialog = vi.fn<() => Promise<string | null>>();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: () => chooseInDialog() }));

import { App } from '@/app/App';
import { useUiStore } from '@/app/ui-store';
import { useCanvasStore } from '@/canvas/canvas-store';
import { useDocumentStore } from '@/editor/document-store';
import type { CanvasNode } from '@/shared/json-canvas';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { emit, isListening, requestClose, resetEvents, windowCalls } from './support/fake-events';
import { button, cleanup, press, render, settle } from './support/render';
import { resetStores } from './support/stores';

const canvas = () => useCanvasStore.getState();
const workspace = () => useWorkspaceStore.getState();
const onDisk = () => JSON.parse(backend.contents('Canvases/Main.canvas'));

const text = (id: string, over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: 'text', text: id, x: 0, y: 0, width: 200, height: 100, ...over }) as CanvasNode;

/** Answer whatever the application is asking, as the user would. */
const answerModal = async (value: unknown): Promise<void> => {
  const modal = useUiStore.getState().modal;
  if (!modal) throw new Error(`nothing was asked`);
  (modal.resolve as (value: unknown) => void)(value);
  await settle();
};

/**
 * The application, mounted, with a workspace and a canvas open.
 *
 * Opening a workspace asks whether to reopen it next time, and that question
 * blocks the keyboard until it is answered — which is the point of it, so the
 * setup here answers it rather than working around it.
 */
const start = async () => {
  const app = await render(<App />);
  await settle();
  await workspace().open('/workspace');
  await canvas().load('Canvases/Main.canvas');
  await settle();
  await answerModal(false);
  backend.calls = [];
  return app;
};

beforeEach(async () => {
  resetStores();
  resetEvents();
  backend.reset();
  chooseInDialog.mockReset();
  chooseInDialog.mockResolvedValue(null);
  localStorage.clear();
  await openFixtureWorkspace();
  await useWorkspaceStore.getState().close();
});

afterEach(async () => {
  await cleanup();
});

describe('mounting', () => {
  it('comes up without a workspace and says how to open one', async () => {
    const app = await render(<App />);
    await settle();

    expect(app.text()).toContain('No workspace open');
    expect(document.getElementById('fatal')).toBeNull();
  });

  it('listens for what Rust has to say', async () => {
    await start();

    expect(isListening('workspace:changed')).toBe(true);
    expect(isListening('tauri://drag-drop')).toBe(true);
    expect(windowCalls.closeRequests).toHaveLength(1);
  });
});

describe('reopening a workspace', () => {
  it('only remembers it when the user says so, and then opens it on start', async () => {
    const app = await render(<App />);
    await settle();
    await workspace().open('/workspace');
    await settle();

    expect(useUiStore.getState().modal?.kind).toBe('confirm');
    await answerModal(true);
    expect(localStorage.getItem('ic.rememberedWorkspace')).toBe('/workspace');

    // A fresh start finds it and opens it without asking again.
    await app.unmount();
    resetStores();
    await render(<App />);
    await settle();
    expect(workspace().workspace?.root).toBe('/workspace');
    expect(useUiStore.getState().modal).toBeNull();
  });

  it('forgets nothing when the user declines', async () => {
    await render(<App />);
    await settle();
    await workspace().open('/workspace');
    await settle();
    await answerModal(false);

    expect(localStorage.getItem('ic.rememberedWorkspace')).toBeNull();
  });
});

describe('a file dropped on the window', () => {
  it('is copied into the workspace and placed on the canvas', async () => {
    await start();

    await emit('tauri://drag-drop', { paths: ['/outside/photo.png'] });
    await settle();

    expect(backend.callsTo('attachment_import')).toEqual([
      { sourcePath: '/outside/photo.png', targetDirectory: 'Attachments' },
    ]);
    // The canvas refers to the copy inside the workspace, never to the original.
    expect((canvas().document.nodes[0] as { file: string }).file).toBe('Attachments/photo.png');
  });

  it('imports several, and says which ones failed', async () => {
    await start();

    await emit('tauri://drag-drop', {
      paths: ['/outside/one.png', '/outside/program.bin', '/outside/two.png'],
    });
    await settle();

    expect(canvas().document.nodes).toHaveLength(2);
    expect(
      useUiStore
        .getState()
        .toasts.filter((toast) => toast.tone === 'error')
        .map((toast) => toast.message)
        .join(),
    ).toContain('not supported');
  });

  it('ignores a drop of nothing', async () => {
    await start();
    await emit('tauri://drag-drop', { paths: [] });
    expect(backend.callsTo('attachment_import')).toEqual([]);
  });
});

describe('a change on disk', () => {
  it('reloads the tree and the affected document', async () => {
    await start();
    await useDocumentStore.getState().open('Notes/note.md');
    backend.write('Notes/note.md', '# Changed elsewhere\n');

    await emit('workspace:changed', { paths: ['Notes/note.md'] });
    await settle();

    expect(useDocumentStore.getState().docs['Notes/note.md']?.contents).toBe(
      '# Changed elsewhere\n',
    );
    expect(backend.callsTo('workspace_open')).toEqual([]);
  });

  it('offers both versions when the canvas changed on both sides', async () => {
    const app = await start();
    canvas().mutate({ type: 'insert-nodes', nodes: [text('mine')] });
    backend.write('Canvases/Main.canvas', JSON.stringify({ nodes: [text('theirs')], edges: [] }));

    await emit('workspace:changed', { paths: ['Canvases/Main.canvas'] });
    await settle();

    expect(app.text()).toContain('changed on disk');

    // Taking the disk version is one click, and it is not the default.
    await settle();
    (button(app.host, 'Use disk version') as HTMLButtonElement).click();
    await settle();
    expect(canvas().document.nodes.map((node) => node.id)).toEqual(['theirs']);
  });
});

describe('closing the window', () => {
  it('finishes writing before the window is destroyed', async () => {
    await start();
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
    await useDocumentStore.getState().open('Notes/note.md');
    useDocumentStore.getState().setContents('Notes/note.md', '# Unsaved\n');

    await requestClose();

    expect(onDisk().nodes).toHaveLength(1);
    expect(backend.contents('Notes/note.md')).toBe('# Unsaved\n');
    // Destroying the window is the last thing that happens, not the first.
    expect(windowCalls.destroyed).toBe(1);
  });

  it('writes what is pending when the window loses focus', async () => {
    await start();
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });

    window.dispatchEvent(new Event('blur'));
    await settle();

    expect(onDisk().nodes).toHaveLength(1);
  });
});

describe('the keyboard', () => {
  it('runs the command a shortcut is bound to', async () => {
    await start();

    await press(window, 'p', { ctrlKey: true });

    expect(useUiStore.getState().paletteOpen).toBe(true);
  });

  it('leaves the keys alone while a modal or the palette is open', async () => {
    await start();
    useUiStore.setState({ paletteOpen: true });

    await press(window, 'a', { ctrlKey: true });

    // Select-all belongs to whatever has focus, not to the canvas behind it.
    expect(canvas().selection).toEqual([]);
  });

  it('leaves editing keys to a focused editor, but still saves', async () => {
    const app = await start();
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
    const field = document.createElement('input');
    app.host.append(field);

    await press(field, 'z', { ctrlKey: true });
    expect(canvas().document.nodes).toHaveLength(1);

    await press(field, 's', { ctrlKey: true });
    await settle();
    expect(onDisk().nodes).toHaveLength(1);
  });

  it('deletes the selection, and clears it on Escape', async () => {
    await start();
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a'), text('b')] });
    canvas().setSelection(['a']);
    // The shell reads the selection through a render, so let one happen.
    await settle();

    await press(window, 'Backspace');
    expect(canvas().document.nodes.map((node) => node.id)).toEqual(['b']);

    canvas().setSelection(['b']);
    await settle();
    await press(window, 'Escape');
    expect(canvas().selection).toEqual([]);
  });

  it('opens the selected node for editing on Enter', async () => {
    await start();
    canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
    canvas().setSelection(['a']);
    await settle();

    await press(window, 'Enter');

    expect(canvas().activeNodeId).toBe('a');
  });
});

describe('a draft left by a crash', () => {
  it('is offered, and adopted when the user accepts', async () => {
    backend.recovery.set('Notes/note.md', {
      relativePath: 'Notes/note.md',
      contents: '# Recovered\n',
      baseRevision: backend.revision('Notes/note.md'),
      savedAtMs: 1,
    });

    await render(<App />);
    await settle();
    await workspace().open('/workspace');
    await settle();
    await answerModal(false);

    const modal = useUiStore.getState().modal;
    expect(modal?.kind).toBe('confirm');
    expect((modal as { message: string }).message).toContain('Notes/note.md');

    await answerModal(true);

    expect(useDocumentStore.getState().docs['Notes/note.md']?.contents).toBe('# Recovered\n');
    expect(useDocumentStore.getState().docs['Notes/note.md']?.dirty).toBe(true);
  });

  it('is discarded when the user declines', async () => {
    backend.recovery.set('Notes/note.md', {
      relativePath: 'Notes/note.md',
      contents: '# Recovered\n',
      baseRevision: '',
      savedAtMs: 1,
    });

    await render(<App />);
    await settle();
    await workspace().open('/workspace');
    await settle();
    await answerModal(false);

    await answerModal(false);

    expect(backend.callsTo('recovery_clear')).toEqual([{ relativePath: 'Notes/note.md' }]);
    expect(useDocumentStore.getState().docs['Notes/note.md']).toBeUndefined();
  });
});
