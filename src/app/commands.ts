/**
 * The command registry contents.
 *
 * Everything the application can do is here. The palette, keyboard shortcuts
 * and the few hover buttons all run these, so behaviour cannot drift between
 * entry points.
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { DEFAULT_SIZES } from '@/canvas/canvas-adapter';
import { useCanvasStore } from '@/canvas/canvas-store';
import { centeredAt, flowInstance } from '@/canvas/flow-bridge';
import { groupAround, offsetNodes, PASTE_OFFSET } from '@/canvas/selection';
import { registerCommands, type AppCommand, type CommandContext } from '@/command-palette/command-registry';
import { useEditorSettings } from '@/editor/editor-settings';
import { useMediaStore, type FitMode } from '@/media/media-view-store';
import { useDocumentStore } from '@/editor/document-store';
import { errorMessage } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';
import {
  MAX_CONTENT_SCALE,
  MIN_CONTENT_SCALE,
  contentScale,
  createId,
  withContentScale,
  type CanvasEdge,
  type CanvasNode,
  type FileNode,
} from '@/shared/json-canvas';
import { useThemeStore } from '@/theme/theme-store';
import {
  DEFAULT_DIRECTORIES,
  baseName,
  stripExtension,
  toSafeFileName,
  useWorkspaceStore,
} from '@/workspace/workspace-store';

import { confirmWith, pickColor, pickFile, promptFor, toast, useUiStore } from './ui-store';

/** Nodes and edges cut or copied, kept inside the application. */
let clipboard: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;

const canvas = () => useCanvasStore.getState();
const workspace = () => useWorkspaceStore.getState();

const hasWorkspace = (context: CommandContext) => context.workspaceRoot !== null;
const hasCanvas = (context: CommandContext) => context.canvasPath !== null;
const hasSelection = (context: CommandContext) => context.selection.length > 0;

const insertNode = (node: CanvasNode): void => {
  canvas().mutate({ type: 'insert-nodes', nodes: [node] });
  canvas().setSelection([node.id]);
};

/** Node kinds that make sense inside a canvas. */
const CANVAS_FILE_KINDS = ['markdown', 'text', 'image', 'pdf', 'video', 'audio'] as const;

export const addFileNode = (relativePath: string): void => {
  const size = DEFAULT_SIZES.file;
  const position = centeredAt(size.width, size.height);
  const node: FileNode = {
    id: createId(),
    type: 'file',
    file: relativePath,
    ...position,
    ...size,
  };
  insertNode(node);
};

const selectedFileNode = (context: CommandContext): FileNode | null => {
  const node = context.selection.find((candidate) => candidate.type === 'file');
  return (node as FileNode | undefined) ?? null;
};

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg'];

const selectedImageNodes = (context: CommandContext): FileNode[] =>
  context.selection.filter(
    (node): node is FileNode =>
      node.type === 'file' &&
      IMAGE_EXTENSIONS.some((extension) => node.file.toLowerCase().endsWith(extension)),
  );

const SCALE_STEP = 1.25;

/** A group is a box around other nodes; scaling it would scale nothing. */
const scalableNodes = (context: CommandContext): CanvasNode[] =>
  context.selection.filter((node) => node.type !== 'group');

/**
 * Draw the selected nodes at a different size, box and contents together.
 *
 * This is the other half of the resize handles: those change how much room the
 * contents have, and the text reflows into it; this changes how big the same
 * thing is drawn, and nothing reflows. A node keeps its centre, so making one
 * smaller leaves it where it was among the others.
 */
const rescaleNodes = (nodes: CanvasNode[], target: (current: number) => number): void => {
  const patches = nodes.flatMap((node) => {
    const current = contentScale(node);
    const next = Math.min(Math.max(target(current), MIN_CONTENT_SCALE), MAX_CONTENT_SCALE);
    const ratio = next / current;
    if (ratio === 1) return [];
    const width = Math.max(1, Math.round(node.width * ratio));
    const height = Math.max(1, Math.round(node.height * ratio));
    return [
      {
        id: node.id,
        changes: {
          x: Math.round(node.x + (node.width - width) / 2),
          y: Math.round(node.y + (node.height - height) / 2),
          width,
          height,
          ...withContentScale(node, next),
        },
      },
    ];
  });
  if (patches.length > 0) canvas().mutate({ type: 'patch-nodes', patches });
};

/** Fit mode is a view preference, so it is not written into the canvas. */
const fitCommand = (id: string, title: string, mode: FitMode): AppCommand => ({
  id,
  title,
  category: 'Image',
  aliases: ['image', 'scale'],
  isAvailable: (context) => selectedImageNodes(context).length > 0,
  execute: (context) => {
    for (const node of selectedImageNodes(context)) {
      useMediaStore.getState().setFit(node.id, mode);
    }
  },
});

const commands: AppCommand[] = [
  /* ------------------------------------------------------------ workspace */
  {
    id: 'workspace.open',
    title: 'Open workspace…',
    category: 'Workspace',
    aliases: ['folder', 'directory'],
    isAvailable: () => true,
    execute: async () => {
      const selected = await openDialog({ directory: true, multiple: false, title: 'Open workspace' });
      if (typeof selected !== 'string') return;
      try {
        await workspace().open(selected);
        toast(`Workspace ${baseName(selected)} opened`);
        const last = workspace().settings.lastCanvas;
        if (last) await canvas().load(last).catch(() => undefined);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  },
  {
    id: 'workspace.close',
    title: 'Close workspace',
    category: 'Workspace',
    isAvailable: hasWorkspace,
    execute: async () => {
      await canvas().save();
      await useDocumentStore.getState().saveAll();
      canvas().closeCanvas();
      await workspace().close();
    },
  },
  {
    id: 'canvas.new',
    title: 'New canvas',
    category: 'Workspace',
    isAvailable: hasWorkspace,
    execute: async () => {
      const name = await promptFor('New canvas', { value: 'Canvas', confirmLabel: 'Create' });
      if (!name) return;
      const path = `${DEFAULT_DIRECTORIES.canvases}/${toSafeFileName(name, '.canvas')}`;
      try {
        await canvas().createCanvas(path);
        toast(`Created ${path}`);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  },
  {
    id: 'note.new',
    title: 'New Markdown note',
    category: 'Workspace',
    aliases: ['markdown file'],
    isAvailable: hasWorkspace,
    execute: async () => {
      const title = await promptFor('New note', { value: 'Note', confirmLabel: 'Create' });
      if (!title) return;
      const path = `${DEFAULT_DIRECTORIES.notes}/${toSafeFileName(title, '.md')}`;
      try {
        await ipc.documentCreate(path, `# ${title}\n\n`);
        await workspace().refreshTree();
        if (canvas().path) addFileNode(path);
        toast(`Created ${path}`);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  },
  {
    id: 'file.open',
    title: 'Open file',
    category: 'Workspace',
    defaultShortcut: 'Mod+O',
    aliases: ['open canvas', 'quick open'],
    isAvailable: hasWorkspace,
    execute: async () => {
      const path = await pickFile('Open file', ['canvas', ...CANVAS_FILE_KINDS]);
      if (!path) return;
      if (path.toLowerCase().endsWith('.canvas')) {
        await canvas().save();
        await canvas().load(path);
      } else if (canvas().path) {
        addFileNode(path);
      } else {
        toast('Open a canvas first to place files on it', 'error');
      }
    },
  },
  {
    id: 'canvas.save',
    title: 'Save',
    category: 'Workspace',
    defaultShortcut: 'Mod+S',
    isAvailable: hasCanvas,
    execute: async () => {
      await canvas().save({ force: true });
      const active = canvas().activeNodeId;
      if (active) {
        const node = canvas().document.nodes.find((candidate) => candidate.id === active);
        if (node?.type === 'file') await useDocumentStore.getState().save(node.file, { force: true });
      }
    },
  },
  {
    id: 'canvas.saveAll',
    title: 'Save all',
    category: 'Workspace',
    defaultShortcut: 'Mod+Shift+S',
    isAvailable: hasWorkspace,
    execute: async () => {
      await canvas().save({ force: true });
      await useDocumentStore.getState().saveAll();
      toast('Saved');
    },
  },

  /* ------------------------------------------------------------------ add */
  {
    id: 'add.markdown',
    title: 'Add inline Markdown node',
    category: 'Add',
    defaultShortcut: 'Mod+Shift+M',
    aliases: ['card', 'text node'],
    isAvailable: hasCanvas,
    execute: () => {
      const size = DEFAULT_SIZES.text;
      const node: CanvasNode = {
        id: createId(),
        type: 'text',
        text: '',
        ...centeredAt(size.width, size.height),
        ...size,
      };
      insertNode(node);
      canvas().setActiveNode(node.id);
    },
  },
  {
    id: 'add.textbox',
    title: 'Add text box',
    category: 'Add',
    aliases: ['title', 'label', 'heading'],
    isAvailable: hasCanvas,
    execute: async () => {
      const text = await promptFor('Text box', { value: '', confirmLabel: 'Add' });
      if (text === null) return;
      const node: CanvasNode = {
        id: createId(),
        type: 'text',
        text,
        ...centeredAt(320, 80),
        width: 320,
        height: 80,
      };
      insertNode(node);
    },
  },
  {
    id: 'add.group',
    title: 'Add group',
    category: 'Add',
    isAvailable: hasCanvas,
    execute: async () => {
      const label = await promptFor('Group label', { value: '', confirmLabel: 'Add' });
      if (label === null) return;
      const size = DEFAULT_SIZES.group;
      const node: CanvasNode = {
        id: createId(),
        type: 'group',
        ...(label ? { label } : {}),
        ...centeredAt(size.width, size.height),
        ...size,
      };
      insertNode(node);
    },
  },
  {
    id: 'add.file',
    title: 'Add file',
    category: 'Add',
    aliases: ['attach', 'image', 'pdf', 'video'],
    isAvailable: hasCanvas,
    execute: async () => {
      const path = await pickFile('Add file to canvas', [...CANVAS_FILE_KINDS]);
      if (path) addFileNode(path);
    },
  },
  {
    id: 'add.link',
    title: 'Add link',
    category: 'Add',
    aliases: ['url', 'bookmark'],
    isAvailable: hasCanvas,
    execute: async () => {
      const url = await promptFor('Link address', {
        value: 'https://',
        message: 'Links are stored as JSON Canvas link nodes and are never fetched.',
        confirmLabel: 'Add',
      });
      if (!url) return;
      const size = DEFAULT_SIZES.link;
      insertNode({
        id: createId(),
        type: 'link',
        url,
        ...centeredAt(size.width, size.height),
        ...size,
      });
    },
  },
  {
    id: 'attachment.import',
    title: 'Import file into workspace…',
    category: 'Add',
    aliases: ['copy attachment'],
    isAvailable: hasWorkspace,
    execute: async () => {
      const selected = await openDialog({ multiple: false, title: 'Import file' });
      if (typeof selected !== 'string') return;
      try {
        const facts = await ipc.attachmentImport(selected, DEFAULT_DIRECTORIES.attachments);
        await workspace().refreshTree();
        if (canvas().path) addFileNode(facts.relativePath);
        toast(`Imported ${baseName(facts.relativePath)}`);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  },

  /* ----------------------------------------------------------------- edit */
  {
    id: 'edit.undo',
    title: 'Undo',
    category: 'Edit',
    defaultShortcut: 'Mod+Z',
    isAvailable: (context) => hasCanvas(context) && !context.isEditing,
    execute: () => canvas().undo(),
  },
  {
    id: 'edit.redo',
    title: 'Redo',
    category: 'Edit',
    defaultShortcut: 'Mod+Shift+Z',
    isAvailable: (context) => hasCanvas(context) && !context.isEditing,
    execute: () => canvas().redo(),
  },
  {
    id: 'edit.cut',
    title: 'Cut',
    category: 'Edit',
    defaultShortcut: 'Mod+X',
    isAvailable: (context) => hasSelection(context) && !context.isEditing,
    execute: (context) => {
      const ids = new Set(context.selection.map((node) => node.id));
      clipboard = {
        nodes: context.selection,
        edges: canvas().document.edges.filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode)),
      };
      canvas().mutate({ type: 'delete-nodes', ids: [...ids] });
    },
  },
  {
    id: 'edit.copy',
    title: 'Copy',
    category: 'Edit',
    defaultShortcut: 'Mod+C',
    isAvailable: (context) => hasSelection(context) && !context.isEditing,
    execute: (context) => {
      const ids = new Set(context.selection.map((node) => node.id));
      clipboard = {
        nodes: context.selection,
        edges: canvas().document.edges.filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode)),
      };
      toast(`${context.selection.length} node(s) copied`);
    },
  },
  {
    id: 'edit.paste',
    title: 'Paste',
    category: 'Edit',
    defaultShortcut: 'Mod+V',
    isAvailable: (context) => hasCanvas(context) && clipboard !== null && !context.isEditing,
    execute: () => {
      if (!clipboard) return;
      const { nodes, idMap } = offsetNodes(clipboard.nodes, PASTE_OFFSET, PASTE_OFFSET);
      const edges = clipboard.edges.map((edge) => ({
        ...edge,
        id: createId(),
        fromNode: idMap.get(edge.fromNode) ?? edge.fromNode,
        toNode: idMap.get(edge.toNode) ?? edge.toNode,
      }));
      canvas().mutate({
        type: 'batch',
        ops: [
          { type: 'insert-nodes', nodes },
          ...(edges.length > 0 ? [{ type: 'insert-edges' as const, edges }] : []),
        ],
      });
      canvas().setSelection(nodes.map((node) => node.id));
    },
  },
  {
    id: 'edit.duplicate',
    title: 'Duplicate',
    category: 'Edit',
    defaultShortcut: 'Mod+D',
    isAvailable: (context) => hasSelection(context) && !context.isEditing,
    execute: (context) => {
      const { nodes } = offsetNodes(context.selection, PASTE_OFFSET, PASTE_OFFSET);
      canvas().mutate({ type: 'insert-nodes', nodes });
      canvas().setSelection(nodes.map((node) => node.id));
    },
  },
  {
    id: 'edit.delete',
    title: 'Delete',
    category: 'Edit',
    defaultShortcut: 'Delete',
    isAvailable: (context) =>
      !context.isEditing && (hasSelection(context) || context.selectedEdgeIds.length > 0),
    execute: (context) => {
      const ops = [];
      if (context.selection.length > 0) {
        ops.push({ type: 'delete-nodes' as const, ids: context.selection.map((node) => node.id) });
      }
      if (context.selectedEdgeIds.length > 0) {
        ops.push({ type: 'delete-edges' as const, ids: context.selectedEdgeIds });
      }
      if (ops.length > 0) canvas().mutate({ type: 'batch', ops });
      canvas().setSelection([]);
    },
  },
  {
    id: 'edit.selectAll',
    title: 'Select all',
    category: 'Edit',
    defaultShortcut: 'Mod+A',
    isAvailable: (context) => hasCanvas(context) && !context.isEditing,
    execute: () => canvas().setSelection(canvas().document.nodes.map((node) => node.id)),
  },
  {
    id: 'edit.group',
    title: 'Group selection',
    category: 'Edit',
    defaultShortcut: 'Mod+G',
    isAvailable: (context) => context.selection.length > 0 && !context.isEditing,
    execute: async (context) => {
      const label = await promptFor('Group label', { value: '', confirmLabel: 'Group' });
      if (label === null) return;
      const group = groupAround(context.selection, label || undefined);
      if (!group) return;
      // Groups render behind their members: insert at the start of the array.
      canvas().mutate({ type: 'insert-nodes', nodes: [group], at: 0 });
      canvas().setSelection([group.id]);
    },
  },
  {
    id: 'edit.ungroup',
    title: 'Ungroup',
    category: 'Edit',
    defaultShortcut: 'Mod+Shift+G',
    isAvailable: (context) =>
      !context.isEditing && context.selection.some((node) => node.type === 'group'),
    execute: (context) => {
      const ids = context.selection.filter((node) => node.type === 'group').map((node) => node.id);
      if (ids.length > 0) canvas().mutate({ type: 'delete-nodes', ids });
    },
  },
  {
    id: 'edit.shrinkNode',
    title: 'Draw node smaller',
    category: 'Edit',
    aliases: ['scale', 'shrink', 'zoom'],
    isAvailable: (context) => scalableNodes(context).length > 0 && !context.isEditing,
    execute: (context) =>
      rescaleNodes(scalableNodes(context), (current) => current / SCALE_STEP),
  },
  {
    id: 'edit.enlargeNode',
    title: 'Draw node larger',
    category: 'Edit',
    aliases: ['scale', 'enlarge', 'zoom'],
    isAvailable: (context) => scalableNodes(context).length > 0 && !context.isEditing,
    execute: (context) =>
      rescaleNodes(scalableNodes(context), (current) => current * SCALE_STEP),
  },
  {
    id: 'edit.resetNodeScale',
    title: 'Draw node at normal size',
    category: 'Edit',
    aliases: ['scale', 'reset'],
    isAvailable: (context) =>
      !context.isEditing && scalableNodes(context).some((node) => contentScale(node) !== 1),
    execute: (context) => rescaleNodes(scalableNodes(context), () => 1),
  },
  {
    id: 'edit.nodeColor',
    title: 'Change node colour',
    category: 'Edit',
    aliases: ['color'],
    isAvailable: hasSelection,
    execute: async (context) => {
      const color = await pickColor('Node colour');
      if (color === undefined) return;
      canvas().mutate({
        type: 'patch-nodes',
        patches: context.selection.map((node) => ({
          id: node.id,
          changes: color === null ? { color: undefined } : { color },
        })),
      });
    },
  },
  {
    id: 'edit.edgeColor',
    title: 'Change edge colour',
    category: 'Edit',
    aliases: ['color', 'arrow'],
    isAvailable: (context) => context.selectedEdgeIds.length > 0,
    execute: async (context) => {
      const color = await pickColor('Edge colour');
      if (color === undefined) return;
      canvas().mutate({
        type: 'patch-edges',
        patches: context.selectedEdgeIds.map((id) => ({
          id,
          changes: color === null ? { color: undefined } : { color },
        })),
      });
    },
  },
  {
    id: 'edit.bringToFront',
    title: 'Bring to front',
    category: 'Edit',
    aliases: ['z-order'],
    isAvailable: hasSelection,
    execute: (context) => {
      const ids = new Set(context.selection.map((node) => node.id));
      const order = canvas().document.nodes.map((node) => node.id);
      canvas().mutate({
        type: 'reorder-nodes',
        order: [...order.filter((id) => !ids.has(id)), ...order.filter((id) => ids.has(id))],
      });
    },
  },
  {
    id: 'edit.sendToBack',
    title: 'Send to back',
    category: 'Edit',
    aliases: ['z-order'],
    isAvailable: hasSelection,
    execute: (context) => {
      const ids = new Set(context.selection.map((node) => node.id));
      const order = canvas().document.nodes.map((node) => node.id);
      canvas().mutate({
        type: 'reorder-nodes',
        order: [...order.filter((id) => ids.has(id)), ...order.filter((id) => !ids.has(id))],
      });
    },
  },

  /* ----------------------------------------------------------------- view */
  {
    id: 'view.fit',
    title: 'Fit canvas',
    category: 'View',
    defaultShortcut: 'Mod+1',
    isAvailable: hasCanvas,
    execute: () => {
      void flowInstance()?.fitView({ padding: 0.15, duration: 180 });
    },
  },
  {
    id: 'view.zoomIn',
    title: 'Zoom in',
    category: 'View',
    defaultShortcut: 'Mod+=',
    isAvailable: hasCanvas,
    execute: () => flowInstance()?.zoomIn({ duration: 120 }),
  },
  {
    id: 'view.zoomOut',
    title: 'Zoom out',
    category: 'View',
    defaultShortcut: 'Mod+-',
    isAvailable: hasCanvas,
    execute: () => flowInstance()?.zoomOut({ duration: 120 }),
  },
  {
    id: 'view.resetZoom',
    title: 'Reset zoom',
    category: 'View',
    defaultShortcut: 'Mod+0',
    isAvailable: hasCanvas,
    execute: () => {
      const flow = flowInstance();
      if (!flow) return;
      const { x, y } = flow.getViewport();
      void flow.setViewport({ x, y, zoom: 1 }, { duration: 120 });
    },
  },
  {
    id: 'view.toggleMinimap',
    title: 'Toggle minimap',
    category: 'View',
    defaultShortcut: 'Mod+M',
    isAvailable: () => true,
    execute: () => {
      const settings = workspace().settings;
      const next = settings.ui.minimap !== true;
      void workspace().patchSettings({ ui: { ...settings.ui, minimap: next } });
    },
  },
  {
    id: 'view.toggleFullscreen',
    title: 'Toggle fullscreen',
    category: 'View',
    // Escape is never the only way out of fullscreen.
    defaultShortcut: 'Mod+Shift+F',
    isAvailable: () => true,
    execute: async () => {
      try {
        await ipc.toggleFullscreen();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  },
  {
    id: 'theme.toggle',
    title: 'Theme: Toggle',
    category: 'View',
    defaultShortcut: 'Mod+Shift+T',
    isAvailable: () => true,
    execute: () => useThemeStore.getState().toggle(),
  },
  {
    id: 'theme.light',
    title: 'Theme: Use Light',
    category: 'View',
    isAvailable: () => true,
    execute: () => useThemeStore.getState().set('light'),
  },
  {
    id: 'theme.dark',
    title: 'Theme: Use Dark',
    category: 'View',
    isAvailable: () => true,
    execute: () => useThemeStore.getState().set('dark'),
  },

  /* ----------------------------------------------------------------- file */
  {
    id: 'file.openExternally',
    title: 'Open externally',
    category: 'File',
    isAvailable: (context) => selectedFileNode(context) !== null,
    execute: async (context) => {
      const node = selectedFileNode(context);
      if (!node) return;
      try {
        await ipc.openPath(node.file);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  },
  {
    id: 'file.reveal',
    title: 'Reveal in file manager',
    category: 'File',
    isAvailable: (context) => selectedFileNode(context) !== null,
    execute: async (context) => {
      const node = selectedFileNode(context);
      if (!node) return;
      try {
        await ipc.revealInFileManager(node.file);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  },
  {
    id: 'file.rename',
    title: 'Set file subpath (heading)',
    category: 'File',
    aliases: ['section', 'anchor'],
    isAvailable: (context) => {
      const node = selectedFileNode(context);
      return node !== null && node.file.toLowerCase().endsWith('.md');
    },
    execute: async (context) => {
      const node = selectedFileNode(context);
      if (!node) return;
      const value = await promptFor('Heading inside the file', {
        value: node.subpath ?? '#',
        message: `Shows only that section of ${stripExtension(baseName(node.file))}.`,
        confirmLabel: 'Apply',
      });
      if (value === null) return;
      const subpath = value.trim();
      canvas().mutate({
        type: 'patch-nodes',
        patches: [
          {
            id: node.id,
            changes: { subpath: subpath.length > 1 ? subpath : undefined },
          },
        ],
      });
    },
  },

  /* ---------------------------------------------------------------- image */
  fitCommand('image.fit', 'Fit', 'fit'),
  fitCommand('image.fill', 'Fill', 'fill'),
  fitCommand('image.originalSize', 'Original size', 'original'),
  {
    id: 'image.resetAspectRatio',
    title: 'Reset aspect ratio',
    category: 'Image',
    isAvailable: (context) => selectedImageNodes(context).length > 0,
    execute: async (context) => {
      const patches = [];
      for (const node of selectedImageNodes(context)) {
        // The true pixel size comes from Rust, never from the node geometry.
        const facts = await ipc.fileFacts(node.file).catch(() => null);
        if (!facts?.width || !facts.height) continue;
        const ratio = facts.height / facts.width;
        patches.push({
          id: node.id,
          changes: { height: Math.max(40, Math.round(node.width * ratio)) },
        });
      }
      if (patches.length > 0) canvas().mutate({ type: 'patch-nodes', patches });
    },
  },

  /* ------------------------------------------------------------- settings */
  {
    id: 'workspace.authorizeExternal',
    title: 'Authorize a folder outside the workspace…',
    category: 'Settings',
    aliases: ['symlink', 'link target'],
    isAvailable: hasWorkspace,
    execute: async () => {
      const ok = await confirmWith(
        'Authorize an external folder',
        'Symlinks pointing outside the workspace are refused by default. Choose a folder to allow this workspace to follow links into it. The choice is stored in workspace settings and can be removed there.',
        'Choose folder',
      );
      if (!ok) return;
      const selected = await openDialog({ directory: true, multiple: false, title: 'Authorize folder' });
      if (typeof selected !== 'string') return;
      try {
        await ipc.authorizeExternal(selected);
        toast(`Authorized ${selected}`);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  },
  {
    id: 'editor.toggleVi',
    title: 'Toggle editor Vi mode',
    category: 'Settings',
    aliases: ['vim', 'modal editing'],
    isAvailable: () => true,
    execute: () => {
      useEditorSettings.getState().toggleVi();
      toast(`Vi mode ${useEditorSettings.getState().viEnabled ? 'enabled' : 'disabled'}`);
    },
  },
  {
    id: 'editor.toggleLivePreview',
    title: 'Toggle editor live preview',
    category: 'Settings',
    aliases: ['markdown', 'syntax', 'wysiwyg'],
    isAvailable: () => true,
    execute: () => {
      useEditorSettings.getState().toggleLivePreview();
      toast(`Live preview ${useEditorSettings.getState().livePreview ? 'enabled' : 'disabled'}`);
    },
  },
  {
    id: 'settings.open',
    title: 'Open settings',
    category: 'Settings',
    isAvailable: () => true,
    execute: () => {
      // Settings are commands, so this filters the palette instead of opening
      // a separate window.
      useUiStore.getState().openPalette();
      useUiStore.setState({ paletteOpen: true });
      window.dispatchEvent(new CustomEvent('ic:palette-query', { detail: 'Settings' }));
    },
  },
  {
    id: 'palette.open',
    title: 'Command palette',
    category: 'Settings',
    defaultShortcut: 'Mod+P',
    aliases: ['commands', 'run'],
    isAvailable: () => true,
    execute: () => useUiStore.getState().togglePalette(),
  },
];

let registered = false;

export const registerAppCommands = (): void => {
  if (registered) return;
  registered = true;
  registerCommands(commands);
};

/** Exposed for tests. */
export const appCommands = commands;
