// @vitest-environment jsdom
/**
 * Every command the application has, run for its effect.
 *
 * The palette, the shortcuts and the hover buttons all execute these, so this is
 * the one place where "does the feature work" can be answered without clicking.
 * Commands are data — `runCommand(id, context)` — so none of this needs a
 * rendered palette or a keyboard.
 *
 * Nothing below is mocked except the two things that leave the process: the
 * native file dialog, and the `ipc` module, which is answered by a workspace in
 * memory that keeps SHA-256 revisions exactly as Rust does. Modal requests carry
 * their own `resolve`, so a prompt or a colour picker is answered here the way the
 * user answers it, through the real code path.
 *
 * The last test in the file fails when a command has no entry in the table, so a
 * command added later cannot quietly go untested.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

const chooseInDialog = vi.fn<() => Promise<string | null>>();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: () => chooseInDialog() }));

import { useUiStore, type InfoRow } from '@/app/ui-store';
import { appCommands, registerAppCommands } from '@/app/commands';
import { useDebugStore } from '@/app/debug-store';
import { selectedNodes, useCanvasStore } from '@/canvas/canvas-store';
import { allCommands, runCommand, type CommandContext } from '@/command-palette/command-registry';
import { useEditorSettings } from '@/editor/editor-settings';
import { useDocumentStore } from '@/editor/document-store';
import { useMediaStore } from '@/media/media-view-store';
import { BUILD } from '@/shared/build-info';
import type { CanvasEdge, CanvasNode } from '@/shared/json-canvas';
import { useThemeStore } from '@/theme/theme-store';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { installFlow, resetStores, type FlowCalls } from './support/stores';

const canvas = () => useCanvasStore.getState();
const workspace = () => useWorkspaceStore.getState();
const document_ = () => useDocumentStore.getState();

let flow: FlowCalls;

/* ------------------------------------------------------------------ helpers */

const context = (over: Partial<CommandContext> = {}): CommandContext => ({
  workspaceRoot: workspace().workspace?.root ?? null,
  canvasPath: canvas().path,
  selection: selectedNodes(),
  selectedEdgeIds: canvas().selectedEdges,
  activeNodeId: canvas().activeNodeId,
  isEditing: false,
  ...over,
});

/** Answer the modal a command is waiting on, as the user would. */
const answer = async (value: unknown): Promise<void> => {
  for (let attempt = 0; attempt < 10 && !useUiStore.getState().modal; attempt += 1) {
    await Promise.resolve();
  }
  const modal = useUiStore.getState().modal;
  if (!modal) throw new Error('the command asked nothing');
  (modal.resolve as (value: unknown) => void)(value);
  await Promise.resolve();
};

/** Take the rows out of the information panel, then close it as the user would. */
const shownRows = async (): Promise<InfoRow[]> => {
  for (let attempt = 0; attempt < 10 && !useUiStore.getState().modal; attempt += 1) {
    await Promise.resolve();
  }
  const modal = useUiStore.getState().modal;
  if (modal?.kind !== 'info') throw new Error(`showed ${modal?.kind ?? 'nothing'}`);
  modal.resolve(null);
  await Promise.resolve();
  return modal.rows;
};

const row = (rows: InfoRow[], label: string): string | undefined =>
  rows.find((entry) => entry.label === label)?.value;

/** Run a command, answering whatever it asks along the way. */
const run = async (
  id: string,
  over: Partial<CommandContext> = {},
  ...answers: unknown[]
): Promise<void> => {
  const done = runCommand(id, context(over));
  for (const value of answers) await answer(value);
  await done;
};

const nodes = (): CanvasNode[] => canvas().document.nodes;
const edges = (): CanvasEdge[] => canvas().document.edges;
const ids = (): string[] => nodes().map((node) => node.id);

const text = (id: string, over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: 'text', text: id, x: 0, y: 0, width: 200, height: 100, ...over }) as CanvasNode;

const file = (id: string, path: string): CanvasNode =>
  ({ id, type: 'file', file: path, x: 0, y: 0, width: 300, height: 200 }) as CanvasNode;

/** Put nodes and edges on the canvas without going through a command. */
const given = (given: { nodes?: CanvasNode[]; edges?: CanvasEdge[]; selected?: string[]; selectedEdges?: string[] }) => {
  useCanvasStore.setState({
    document: { nodes: given.nodes ?? [], edges: given.edges ?? [] },
    selection: given.selected ?? [],
    selectedEdges: given.selectedEdges ?? [],
    dirty: false,
  });
};

const openWorkspace = async (): Promise<void> => {
  await workspace().loadFacts();
  await workspace().open('/workspace');
};

const openCanvas = async (): Promise<void> => {
  await openWorkspace();
  await canvas().load('Canvases/Main.canvas');
};

/* --------------------------------------------------------------- the table */

type Check = () => Promise<void>;

/**
 * A command may have more than one case worth stating — what it does, and what it
 * does when the user cancels — so each id holds a list rather than one check.
 */
const checks = new Map<string, Check[]>();
const covers = (id: string, check: Check): void => {
  checks.set(id, [...(checks.get(id) ?? []), check]);
};

/* ------------------------------------------------------------------ workspace */

covers('workspace.open', async () => {
  backend.settings.lastCanvas = 'Canvases/Main.canvas';
  chooseInDialog.mockResolvedValue('/chosen/workspace');

  await run('workspace.open');

  expect(backend.callsTo('workspace_open')).toEqual([{ path: '/chosen/workspace' }]);
  expect(workspace().workspace?.name).toBe('workspace');
  // The workspace remembers which canvas was open, and reopening restores it.
  expect(canvas().path).toBe('Canvases/Main.canvas');
  expect(useUiStore.getState().toasts.at(-1)?.message).toContain('opened');
});

covers('workspace.open', async () => {
  chooseInDialog.mockResolvedValue(null);
  await run('workspace.open');
  // Cancelling the picker changes nothing at all.
  expect(backend.callsTo('workspace_open')).toEqual([]);
  expect(workspace().workspace).toBeNull();
});

covers('workspace.close', async () => {
  await openCanvas();
  canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });

  await run('workspace.close');

  // Closing saves first: unsaved work is never dropped on the way out.
  expect(backend.callsTo('document_write')).toHaveLength(1);
  expect(canvas().path).toBeNull();
  expect(workspace().workspace).toBeNull();
  expect(nodes()).toEqual([]);
});

covers('canvas.new', async () => {
  await openWorkspace();

  await run('canvas.new', {}, 'Ideas');

  expect(JSON.parse(backend.contents('Canvases/Ideas.canvas'))).toEqual({ nodes: [], edges: [] });
  expect(canvas().path).toBe('Canvases/Ideas.canvas');
  expect(workspace().settings.lastCanvas).toBe('Canvases/Ideas.canvas');
});

covers('note.new', async () => {
  await openCanvas();

  await run('note.new', {}, 'Meeting notes');

  expect(backend.contents('Notes/Meeting notes.md')).toBe('# Meeting notes\n\n');
  // With a canvas open the new note is placed on it.
  expect(nodes()).toHaveLength(1);
  expect((nodes()[0] as { file: string }).file).toBe('Notes/Meeting notes.md');
});

covers('file.open', async () => {
  await openCanvas();
  backend.write('Canvases/Other.canvas', '{"nodes":[],"edges":[]}');

  await run('file.open', {}, 'Canvases/Other.canvas');
  expect(canvas().path).toBe('Canvases/Other.canvas');

  // Anything that is not a canvas is placed on the open one instead.
  await run('file.open', {}, 'Notes/note.md');
  expect((nodes().at(-1) as { file: string }).file).toBe('Notes/note.md');
});

covers('canvas.save', async () => {
  await openCanvas();
  canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
  await document_().open('Notes/note.md');
  document_().setContents('Notes/note.md', '# Edited\n');

  await run('canvas.save', { activeNodeId: 'n-file' });

  expect(JSON.parse(backend.contents('Canvases/Main.canvas')).nodes).toHaveLength(1);
  expect(canvas().dirty).toBe(false);
});

covers('canvas.saveAll', async () => {
  await openCanvas();
  canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
  await document_().open('Notes/note.md');
  document_().setContents('Notes/note.md', '# Edited\n');

  await run('canvas.saveAll');

  expect(JSON.parse(backend.contents('Canvases/Main.canvas')).nodes).toHaveLength(1);
  // Both kinds of document reach disk, not just the canvas.
  expect(backend.contents('Notes/note.md')).toBe('# Edited\n');
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Saved');
});

/* ------------------------------------------------------------------------ add */

covers('add.markdown', async () => {
  await openCanvas();

  await run('add.markdown');

  expect(nodes()).toHaveLength(1);
  expect(nodes()[0]?.type).toBe('text');
  // A new note opens for editing straight away.
  expect(canvas().activeNodeId).toBe(nodes()[0]?.id);
  expect(canvas().selection).toEqual(ids());
});

covers('add.textbox', async () => {
  await openCanvas();

  await run('add.textbox', {}, 'A heading');

  expect((nodes()[0] as { text: string }).text).toBe('A heading');
  expect(canvas().activeNodeId).toBeNull();
});

covers('add.group', async () => {
  await openCanvas();

  await run('add.group', {}, 'Ideas');

  expect(nodes()[0]?.type).toBe('group');
  expect((nodes()[0] as { label?: string }).label).toBe('Ideas');
});

covers('add.file', async () => {
  await openCanvas();

  await run('add.file', {}, 'Attachments/square.png');

  expect((nodes()[0] as { file: string }).file).toBe('Attachments/square.png');
});

covers('add.link', async () => {
  await openCanvas();

  await run('add.link', {}, 'https://example.org/page');

  expect(nodes()[0]?.type).toBe('link');
  expect((nodes()[0] as { url: string }).url).toBe('https://example.org/page');
});

covers('attachment.import', async () => {
  await openCanvas();
  chooseInDialog.mockResolvedValue('/outside/photo.png');

  await run('attachment.import');

  expect(backend.callsTo('attachment_import')).toEqual([
    { sourcePath: '/outside/photo.png', targetDirectory: 'Attachments' },
  ]);
  // The copy inside the workspace is what the canvas refers to.
  expect((nodes()[0] as { file: string }).file).toBe('Attachments/photo.png');
  expect(workspace().tree.some((entry) => entry.name === 'Attachments')).toBe(true);
});

/* ----------------------------------------------------------------------- edit */

covers('edit.undo', async () => {
  await openCanvas();
  canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });

  await run('edit.undo');

  expect(nodes()).toEqual([]);
  expect(canvas().history.future).toHaveLength(1);
});

covers('edit.redo', async () => {
  await openCanvas();
  canvas().mutate({ type: 'insert-nodes', nodes: [text('a')] });
  canvas().undo();

  await run('edit.redo');

  expect(ids()).toEqual(['a']);
});

covers('edit.cut', async () => {
  await openCanvas();
  given({
    nodes: [text('a'), text('b')],
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' } as CanvasEdge],
    selected: ['a', 'b'],
  });

  await run('edit.cut');

  expect(nodes()).toEqual([]);
  // The edge between them went with them, and comes back on paste.
  await run('edit.paste');
  expect(nodes()).toHaveLength(2);
  expect(edges()).toHaveLength(1);
});

covers('edit.copy', async () => {
  await openCanvas();
  given({ nodes: [text('a')], selected: ['a'] });

  await run('edit.copy');

  expect(ids()).toEqual(['a']);
  expect(useUiStore.getState().toasts.at(-1)?.message).toContain('1 node');
});

covers('edit.paste', async () => {
  await openCanvas();
  given({ nodes: [text('a', { x: 10, y: 20 })], selected: ['a'] });
  await run('edit.copy');

  await run('edit.paste');

  expect(nodes()).toHaveLength(2);
  const pasted = nodes()[1] as CanvasNode;
  // A copy is offset and gets its own identity.
  expect(pasted.id).not.toBe('a');
  expect(pasted.x).toBe(42);
  expect(pasted.y).toBe(52);
  expect(canvas().selection).toEqual([pasted.id]);
});

covers('edit.duplicate', async () => {
  await openCanvas();
  given({ nodes: [text('a', { x: 0, y: 0 })], selected: ['a'] });

  await run('edit.duplicate');

  expect(nodes()).toHaveLength(2);
  expect(nodes()[1]?.x).toBe(32);
  expect(canvas().selection).toEqual([nodes()[1]?.id]);
});

covers('edit.delete', async () => {
  await openCanvas();
  given({
    nodes: [text('a'), text('b')],
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' } as CanvasEdge],
    selected: ['a'],
    selectedEdges: ['e1'],
  });

  await run('edit.delete');

  expect(ids()).toEqual(['b']);
  expect(edges()).toEqual([]);
  expect(canvas().selection).toEqual([]);
});

covers('edit.selectAll', async () => {
  await openCanvas();
  given({ nodes: [text('a'), text('b')] });

  await run('edit.selectAll');

  expect(canvas().selection).toEqual(['a', 'b']);
});

covers('edit.group', async () => {
  await openCanvas();
  given({
    nodes: [text('a', { x: 0, y: 0 }), text('b', { x: 400, y: 300 })],
    selected: ['a', 'b'],
  });

  await run('edit.group', {}, 'Cluster');

  // A group is inserted first in the array, which is what puts it behind its
  // members without reordering anything else.
  expect(nodes()[0]?.type).toBe('group');
  expect((nodes()[0] as { label?: string }).label).toBe('Cluster');
  expect(nodes()).toHaveLength(3);
  expect(canvas().selection).toEqual([nodes()[0]?.id]);
});

covers('edit.ungroup', async () => {
  await openCanvas();
  const group = { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 400 } as CanvasNode;
  given({ nodes: [group, text('a')], selected: ['g'] });

  await run('edit.ungroup');

  // Only the group goes; what was inside it stays exactly where it was.
  expect(ids()).toEqual(['a']);
});

/**
 * Drawing a node smaller is not resizing it: the box and the contents move
 * together, so nothing inside reflows and zooming in brings the whole thing
 * back. The scale is not a JSON Canvas field, so it rides in the node's extra
 * bag and has to survive being written and read back.
 */
covers('edit.shrinkNode', async () => {
  await openCanvas();
  given({ nodes: [text('a', { x: 0, y: 0, width: 200, height: 100 })], selected: ['a'] });

  await run('edit.shrinkNode');

  const node = nodes()[0]!;
  expect(node.extra).toEqual({ icScale: 0.8 });
  expect([node.width, node.height]).toEqual([160, 80]);
  // Around its centre, so a node made smaller stays where it was among the rest.
  expect([node.x, node.y]).toEqual([20, 10]);
});

covers('edit.shrinkNode', async () => {
  await openCanvas();
  const group = { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 400 } as CanvasNode;
  given({ nodes: [group], selected: ['g'] });

  // A group is a box around other nodes; it has no contents of its own to draw.
  expect(allCommands().find((c) => c.id === 'edit.shrinkNode')?.isAvailable(context())).toBe(false);
  await run('edit.shrinkNode');
  expect(nodes()[0]?.width).toBe(400);
});

covers('edit.enlargeNode', async () => {
  await openCanvas();
  given({ nodes: [text('a', { width: 200, height: 100 })], selected: ['a'] });

  await run('edit.enlargeNode');
  expect(nodes()[0]?.extra).toEqual({ icScale: 1.25 });
  expect(nodes()[0]?.width).toBe(250);

  // Undo takes back the size and the scale together, as one change.
  canvas().undo();
  expect(nodes()[0]?.extra).toBeUndefined();
  expect(nodes()[0]?.width).toBe(200);
});

covers('edit.enlargeNode', async () => {
  await openCanvas();
  given({ nodes: [text('a', { extra: { icScale: 16, author: 'someone else' } })], selected: ['a'] });

  await run('edit.enlargeNode');

  // Already at the largest it will draw: nothing moves, and a key this
  // application does not own is still there.
  expect(nodes()[0]?.extra).toEqual({ icScale: 16, author: 'someone else' });
  expect(nodes()[0]?.width).toBe(200);
});

covers('edit.resetNodeScale', async () => {
  await openCanvas();
  given({
    nodes: [text('a', { width: 160, height: 80, extra: { icScale: 0.8, author: 'someone else' } })],
    selected: ['a'],
  });

  await run('edit.resetNodeScale');

  // Back to normal is written as no scale at all, so the node is saved exactly
  // as one that had never been scaled — the foreign key still untouched.
  expect(nodes()[0]?.extra).toEqual({ author: 'someone else' });
  expect([nodes()[0]?.width, nodes()[0]?.height]).toEqual([200, 100]);
  expect(
    allCommands().find((c) => c.id === 'edit.resetNodeScale')?.isAvailable(context()),
  ).toBe(false);
});

covers('edit.nodeColor', async () => {
  await openCanvas();
  given({ nodes: [text('a'), text('b')], selected: ['a', 'b'] });

  await run('edit.nodeColor', {}, '3');
  expect(nodes().map((node) => node.color)).toEqual(['3', '3']);

  // Choosing nothing clears the colour; cancelling would leave it alone.
  await run('edit.nodeColor', {}, null);
  expect(nodes().map((node) => node.color)).toEqual([undefined, undefined]);

  await run('edit.nodeColor', {}, '5');
  await run('edit.nodeColor', {}, undefined);
  expect(nodes().map((node) => node.color)).toEqual(['5', '5']);
});

covers('edit.edgeColor', async () => {
  await openCanvas();
  given({
    nodes: [text('a'), text('b')],
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' } as CanvasEdge],
    selectedEdges: ['e1'],
  });

  await run('edit.edgeColor', {}, '2');

  expect(edges()[0]?.color).toBe('2');
});

covers('edit.bringToFront', async () => {
  await openCanvas();
  given({ nodes: [text('a'), text('b'), text('c')], selected: ['a'] });

  await run('edit.bringToFront');

  // Array order is z-order, so the front is the end.
  expect(ids()).toEqual(['b', 'c', 'a']);
});

covers('edit.sendToBack', async () => {
  await openCanvas();
  given({ nodes: [text('a'), text('b'), text('c')], selected: ['c'] });

  await run('edit.sendToBack');

  expect(ids()).toEqual(['c', 'a', 'b']);
});

/* ----------------------------------------------------------------------- view */

covers('view.fit', async () => {
  await openCanvas();
  await run('view.fit');
  expect(flow.fitView).toBe(1);
});

covers('view.zoomIn', async () => {
  await openCanvas();
  await run('view.zoomIn');
  expect(flow.zoomIn).toBe(1);
});

covers('view.zoomOut', async () => {
  await openCanvas();
  await run('view.zoomOut');
  expect(flow.zoomOut).toBe(1);
});

covers('view.resetZoom', async () => {
  await openCanvas();
  flow.viewport = { x: -100, y: -200, zoom: 2.5 };

  await run('view.resetZoom');

  // Zoom returns to 1 without recentring: the view stays where the user was.
  expect(flow.viewport).toEqual({ x: -100, y: -200, zoom: 1 });
});

covers('view.toggleMinimap', async () => {
  await openWorkspace();

  await run('view.toggleMinimap');
  expect(workspace().settings.ui.minimap).toBe(true);
  // A view preference is workspace state, so it survives a restart.
  expect(backend.settings.ui.minimap).toBe(true);

  await run('view.toggleMinimap');
  expect(workspace().settings.ui.minimap).toBe(false);
});

covers('view.toggleFullscreen', async () => {
  await run('view.toggleFullscreen');

  // The window belongs to Rust; the frontend only asks.
  expect(backend.callsTo('window_toggle_fullscreen')).toHaveLength(1);
  expect(backend.fullscreen).toBe(true);
});

covers('theme.toggle', async () => {
  await run('theme.toggle');
  expect(useThemeStore.getState().theme).toBe('dark');
  await run('theme.toggle');
  expect(useThemeStore.getState().theme).toBe('light');
});

covers('theme.light', async () => {
  useThemeStore.getState().set('dark');
  await run('theme.light');
  expect(useThemeStore.getState().theme).toBe('light');
  expect(document.documentElement.dataset.theme).toBe('light');
});

covers('theme.dark', async () => {
  await run('theme.dark');
  expect(useThemeStore.getState().theme).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
});

/* ----------------------------------------------------------------------- file */

covers('file.openExternally', async () => {
  await openCanvas();
  given({ nodes: [file('f', 'Attachments/doc.pdf')], selected: ['f'] });

  await run('file.openExternally');

  expect(backend.callsTo('external_open_path')).toEqual([
    { relativePath: 'Attachments/doc.pdf' },
  ]);
});

covers('file.reveal', async () => {
  await openCanvas();
  given({ nodes: [file('f', 'Attachments/doc.pdf')], selected: ['f'] });

  await run('file.reveal');

  expect(backend.callsTo('reveal_in_file_manager')).toEqual([
    { relativePath: 'Attachments/doc.pdf' },
  ]);
});

covers('file.rename', async () => {
  await openCanvas();
  given({ nodes: [file('f', 'Notes/note.md')], selected: ['f'] });

  await run('file.rename', {}, '#Findings');
  expect((nodes()[0] as { subpath?: string }).subpath).toBe('#Findings');

  // A bare `#` means the whole file again, not a heading called nothing.
  await run('file.rename', {}, '#');
  expect((nodes()[0] as { subpath?: string }).subpath).toBeUndefined();
});

/* ---------------------------------------------------------------------- image */

const fitCommand = (id: string, expected: string) =>
  covers(id, async () => {
    await openCanvas();
    given({ nodes: [file('i', 'Attachments/square.png')], selected: ['i'] });

    await run(id);

    expect(useMediaStore.getState().fit.i).toBe(expected);
    // How an image is shown is a view preference, never part of the document.
    expect(canvas().dirty).toBe(false);
  });

fitCommand('image.fit', 'fit');
fitCommand('image.fill', 'fill');
fitCommand('image.originalSize', 'original');

covers('image.resetAspectRatio', async () => {
  await openCanvas();
  backend.write('Attachments/tall.png', 'pretend png', { width: 100, height: 300 });
  given({
    nodes: [file('i', 'Attachments/tall.png') as CanvasNode],
    selected: ['i'],
  });

  await run('image.resetAspectRatio');

  // 300px wide node, 1:3 image, so 900px tall — from the file's real size,
  // never from whatever the node happened to be.
  expect(nodes()[0]?.height).toBe(900);
});

/* ------------------------------------------------------------------- settings */

covers('workspace.authorizeExternal', async () => {
  await openWorkspace();
  chooseInDialog.mockResolvedValue('/outside/shared');

  await run('workspace.authorizeExternal', {}, true);

  expect(backend.callsTo('workspace_authorize_external')).toEqual([{ path: '/outside/shared' }]);
});

covers('workspace.authorizeExternal', async () => {
  await openWorkspace();
  chooseInDialog.mockResolvedValue('/outside/shared');

  // Declining the explanation must not open a picker at all.
  await run('workspace.authorizeExternal', {}, false);

  expect(chooseInDialog).not.toHaveBeenCalled();
  expect(backend.callsTo('workspace_authorize_external')).toEqual([]);
});

covers('editor.toggleVi', async () => {
  await run('editor.toggleVi');
  expect(useEditorSettings.getState().viEnabled).toBe(true);
  await run('editor.toggleVi');
  expect(useEditorSettings.getState().viEnabled).toBe(false);
});

covers('editor.toggleLivePreview', async () => {
  expect(useEditorSettings.getState().livePreview).toBe(true);
  await run('editor.toggleLivePreview');
  expect(useEditorSettings.getState().livePreview).toBe(false);
});

covers('settings.open', async () => {
  const queries: string[] = [];
  const listener = (event: Event) => queries.push((event as CustomEvent<string>).detail);
  window.addEventListener('ic:palette-query', listener);

  await run('settings.open');

  window.removeEventListener('ic:palette-query', listener);
  // Settings are commands, so this filters the palette rather than opening a
  // window of its own.
  expect(useUiStore.getState().paletteOpen).toBe(true);
  expect(queries).toEqual(['Settings']);
});

covers('palette.open', async () => {
  await run('palette.open');
  expect(useUiStore.getState().paletteOpen).toBe(true);
  await run('palette.open');
  expect(useUiStore.getState().paletteOpen).toBe(false);
});

covers('debug.toggle', async () => {
  await run('debug.toggle');
  expect(useDebugStore.getState().enabled).toBe(true);
  // The status bar stops fading out, which is a stylesheet rule on this.
  expect(document.documentElement.dataset.debug).toBe('on');
  // And the stores are reachable from the webview console.
  expect((window as { ic?: unknown }).ic).toBeDefined();

  await run('debug.toggle');
  expect(useDebugStore.getState().enabled).toBe(false);
  expect(document.documentElement.dataset.debug).toBeUndefined();
  expect((window as { ic?: unknown }).ic).toBeUndefined();
});

covers('help.information', async () => {
  await openCanvas();
  given({ nodes: [text('a'), text('b')] });

  const done = runCommand('help.information', context());
  const rows = await shownRows();
  await done;

  // The version the desktop application reports about itself, not the bundle's.
  expect(row(rows, 'Version')).toBe(backend.facts.version);
  expect(row(rows, 'Commit')).toBe(BUILD.commit);
  expect(row(rows, 'Workspace')).toBe('/workspace');
  expect(row(rows, 'Canvas')).toBe('Canvases/Main.canvas');
  expect(row(rows, 'Contents')).toBe('2 nodes, 0 edges');
  // The internals are noise until someone is debugging.
  expect(rows.some((entry) => entry.label === 'Media origin')).toBe(false);
});

/* ------------------------------------------------------------------ the tests */

beforeAll(() => {
  registerAppCommands();
});

beforeEach(async () => {
  resetStores();
  backend.reset();
  chooseInDialog.mockReset();
  chooseInDialog.mockResolvedValue(null);
  flow = installFlow();
  await openFixtureWorkspace();
  // Opened through the store in each check, so a command sees the state a user
  // would have. The fixtures are on disk either way.
  await workspace().close();
  // Only what the command under test asks for should appear in the log.
  backend.calls = [];
  vi.useFakeTimers();
});

afterEach(() => {
  // Autosave and viewport timers must not fire into the next test.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('every command, run for its effect', () => {
  for (const [id, cases] of checks) {
    cases.forEach((check, index) => {
      it(cases.length > 1 ? `${id} (${index + 1})` : id, check);
    });
  }
});

describe('the table itself', () => {
  it('covers every command in the registry', () => {
    const missing = allCommands()
      .map((command) => command.id)
      .filter((id) => !checks.has(id));
    expect(missing).toEqual([]);
  });

  it('is not testing commands that no longer exist', () => {
    const ids = new Set(appCommands.map((command) => command.id));
    expect([...checks.keys()].filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe('when a command is available', () => {
  it('needs a workspace before it will touch one', () => {
    resetStores();
    const empty = context({ workspaceRoot: null, canvasPath: null });
    const unavailable = ['workspace.close', 'canvas.new', 'note.new', 'attachment.import'];
    for (const id of unavailable) {
      expect(allCommands().find((c) => c.id === id)?.isAvailable(empty), id).toBe(false);
    }
  });

  it('needs a canvas before it will add to one', () => {
    const withoutCanvas = context({ workspaceRoot: '/workspace', canvasPath: null });
    for (const id of ['add.markdown', 'add.file', 'add.link', 'edit.selectAll', 'view.fit']) {
      expect(allCommands().find((c) => c.id === id)?.isAvailable(withoutCanvas), id).toBe(false);
    }
  });

  /** While a text editor has focus, editing shortcuts belong to the editor. */
  it('keeps out of the way of an editor', () => {
    const editing = context({
      workspaceRoot: '/workspace',
      canvasPath: 'Canvases/Main.canvas',
      selection: [text('a')],
      isEditing: true,
    });
    for (const id of ['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.delete']) {
      expect(allCommands().find((c) => c.id === id)?.isAvailable(editing), id).toBe(false);
    }
  });

  it('offers the file commands only for a file node', () => {
    const base = { workspaceRoot: '/workspace', canvasPath: 'Canvases/Main.canvas' };
    const onText = context({ ...base, selection: [text('a')] });
    const onFile = context({ ...base, selection: [file('f', 'Notes/note.md')] });
    const onImage = context({ ...base, selection: [file('i', 'Attachments/square.png')] });

    const available = (id: string, ctx: CommandContext) =>
      allCommands().find((command) => command.id === id)?.isAvailable(ctx);

    expect(available('file.openExternally', onText)).toBe(false);
    expect(available('file.openExternally', onFile)).toBe(true);
    // Only Markdown has headings to point at.
    expect(available('file.rename', onFile)).toBe(true);
    expect(available('file.rename', onImage)).toBe(false);
    // And only images have a fit mode.
    expect(available('image.fit', onFile)).toBe(false);
    expect(available('image.fit', onImage)).toBe(true);
  });
});
