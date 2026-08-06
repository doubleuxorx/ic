/**
 * The Rust side of the application, in memory.
 *
 * Every command the frontend can call is here, over a workspace of plain
 * objects, so a test can drive real stores and real components through their real
 * code paths without a backend. It is deliberately not a stub that returns
 * whatever a test wants: revisions are SHA-256 of the contents as they are in
 * Rust, so a conflict happens for the same reason it happens in the application,
 * and a refusal is the same string the user would see.
 *
 * What it is not is a second implementation of the security rules — those are
 * tested where they live, in `src-tauri/src/security`. The few refusals here exist
 * so the frontend's handling of them can be tested at all.
 */

import { createHash } from 'node:crypto';

import type {
  AppFacts,
  DocumentContent,
  FileEntry,
  FileFacts,
  FileKind,
  MediaProbe,
  RecoveryRecord,
  Thumbnail,
  WorkspaceInfo,
  WorkspaceSettings,
  WriteResult,
} from '@/shared/ipc-types';

const KINDS: Array<[string[], FileKind]> = [
  [['md', 'markdown'], 'markdown'],
  [['canvas'], 'canvas'],
  [['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'], 'image'],
  [['pdf'], 'pdf'],
  [['mp4', 'webm', 'm4v', 'mov', 'mkv'], 'video'],
  [['mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac'], 'audio'],
  [['txt', 'csv', 'log'], 'text'],
];

export const kindOf = (path: string): FileKind => {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return KINDS.find(([extensions]) => extensions.includes(extension))?.[1] ?? 'unsupported';
};

const revisionOf = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

interface FakeFile {
  contents: string;
  /** Images report dimensions; everything else reports none. */
  width?: number;
  height?: number;
}

/** One call the frontend made, for asserting on the ones that reach the system. */
export interface Call {
  command: string;
  args: unknown;
}

const defaultSettings = (): WorkspaceSettings => ({
  lastCanvas: null,
  viewports: {},
  authorizedExternalPaths: [],
  ui: {},
});

const defaultFacts = (): AppFacts => ({
  protocolScheme: 'ic',
  protocolHost: 'ic://localhost',
  platform: 'linux',
  version: '0.4.0',
  initialWorkspace: null,
  mediaOrigin: null,
});

class Backend {
  root: string | null = null;
  files = new Map<string, FakeFile>();
  settings = defaultSettings();
  facts = defaultFacts();
  recovery = new Map<string, RecoveryRecord>();
  fullscreen = false;
  calls: Call[] = [];
  /** Paths that answer with a refusal, whatever they contain. */
  refuse = new Map<string, string>();

  reset(): void {
    this.root = null;
    this.files.clear();
    this.settings = defaultSettings();
    this.facts = defaultFacts();
    this.recovery.clear();
    this.fullscreen = false;
    this.calls = [];
    this.refuse.clear();
  }

  /** Populate a workspace without going through the picker. */
  give(files: Record<string, string>): void {
    for (const [path, contents] of Object.entries(files)) this.write(path, contents);
  }

  write(path: string, contents: string, size?: { width: number; height: number }): void {
    this.files.set(path, { contents, ...(size ?? {}) });
  }

  contents(path: string): string {
    const file = this.files.get(path);
    if (!file) throw new Error(`${path} is not in the fake workspace`);
    return file.contents;
  }

  revision(path: string): string {
    return revisionOf(this.contents(path));
  }

  private record(command: string, args: unknown): void {
    this.calls.push({ command, args });
  }

  /** Every call of a command, in order. */
  callsTo(command: string): unknown[] {
    return this.calls.filter((call) => call.command === command).map((call) => call.args);
  }

  private open(): string {
    if (this.root === null) throw 'no workspace is open';
    return this.root;
  }

  private check(path: string): FakeFile {
    this.open();
    const refusal = this.refuse.get(path);
    if (refusal) throw refusal;
    if (path.includes('..')) throw 'path escapes the workspace';
    if (path.startsWith('/')) throw 'absolute paths are not accepted';
    const file = this.files.get(path);
    if (!file) throw 'path does not exist';
    return file;
  }

  private tree(): FileEntry[] {
    const roots: FileEntry[] = [];
    const directories = new Map<string, FileEntry>();

    const directory = (path: string): FileEntry[] => {
      if (path === '') return roots;
      const existing = directories.get(path);
      if (existing?.children) return existing.children;
      const index = path.lastIndexOf('/');
      const parent = directory(index === -1 ? '' : path.slice(0, index));
      const entry: FileEntry = {
        name: index === -1 ? path : path.slice(index + 1),
        relativePath: path,
        isDirectory: true,
        kind: 'unsupported',
        size: 0,
        modifiedMs: 0,
        children: [],
      };
      directories.set(path, entry);
      parent.push(entry);
      return entry.children as FileEntry[];
    };

    for (const [path, file] of this.files) {
      // `.app` holds caches and settings, and is never browsable.
      if (path.startsWith('.app/') || kindOf(path) === 'unsupported') continue;
      const index = path.lastIndexOf('/');
      directory(index === -1 ? '' : path.slice(0, index)).push({
        name: index === -1 ? path : path.slice(index + 1),
        relativePath: path,
        isDirectory: false,
        kind: kindOf(path),
        size: file.contents.length,
        modifiedMs: 0,
      });
    }

    const sort = (entries: FileEntry[]): FileEntry[] => {
      entries.sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) ||
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );
      for (const entry of entries) if (entry.children) sort(entry.children);
      return entries;
    };
    return sort(roots);
  }

  private facts_for(path: string): FileFacts {
    const file = this.check(path);
    return {
      relativePath: path,
      kind: kindOf(path),
      size: file.contents.length,
      modifiedMs: 0,
      width: file.width ?? null,
      height: file.height ?? null,
      external: false,
    };
  }

  readonly ipc = {
    appFacts: async (): Promise<AppFacts> => this.facts,

    workspaceOpen: async (path: string): Promise<WorkspaceInfo> => {
      this.record('workspace_open', { path });
      this.root = path;
      return { root: path, name: path.split('/').filter(Boolean).pop() ?? path };
    },
    workspaceClose: async (): Promise<void> => {
      this.record('workspace_close', {});
      this.root = null;
    },
    workspaceTree: async (): Promise<FileEntry[]> => {
      this.open();
      return this.tree();
    },
    workspaceCreateDirectory: async (relativePath: string): Promise<void> => {
      this.record('workspace_create_directory', { relativePath });
      this.open();
    },
    settingsRead: async (): Promise<WorkspaceSettings> => {
      this.open();
      return structuredClone(this.settings);
    },
    settingsWrite: async (settings: WorkspaceSettings): Promise<void> => {
      this.record('workspace_settings_write', { settings });
      this.open();
      this.settings = structuredClone(settings);
    },
    authorizeExternal: async (path: string): Promise<string[]> => {
      this.record('workspace_authorize_external', { path });
      this.open();
      this.settings.authorizedExternalPaths = [
        ...new Set([...this.settings.authorizedExternalPaths, path]),
      ];
      return this.settings.authorizedExternalPaths;
    },

    documentRead: async (relativePath: string): Promise<DocumentContent> => {
      const file = this.check(relativePath);
      if (!['markdown', 'canvas', 'text'].includes(kindOf(relativePath))) {
        throw `file type is not supported: ${relativePath}`;
      }
      return {
        relativePath,
        contents: file.contents,
        revision: revisionOf(file.contents),
        modifiedMs: 0,
      };
    },
    documentWrite: async (
      relativePath: string,
      expectedRevision: string,
      contents: string,
    ): Promise<WriteResult> => {
      this.record('document_write', { relativePath, expectedRevision, contents });
      this.open();
      const refusal = this.refuse.get(relativePath);
      if (refusal) throw refusal;
      const existing = this.files.get(relativePath);
      const current = existing ? revisionOf(existing.contents) : '';
      if (current !== expectedRevision) {
        // The same shape Rust sends, so the frontend's conflict handling is
        // exercised rather than approximated.
        throw {
          kind: 'revision-mismatch',
          message: 'the file changed on disk since it was loaded',
          currentRevision: current,
          currentContents: existing?.contents ?? '',
        };
      }
      this.write(relativePath, contents);
      return { relativePath, revision: revisionOf(contents), modifiedMs: 0 };
    },
    documentCreate: async (relativePath: string, contents: string): Promise<WriteResult> =>
      this.ipc.documentWrite(relativePath, '', contents),

    fileFacts: async (relativePath: string): Promise<FileFacts> => this.facts_for(relativePath),
    thumbnailRequest: async (relativePath: string): Promise<Thumbnail> => {
      this.record('thumbnail_request', { relativePath });
      const facts = this.facts_for(relativePath);
      if (facts.kind !== 'image') throw `file type is not supported: ${relativePath}`;
      const width = facts.width ?? 0;
      const height = facts.height ?? 0;
      // Small images are rendered directly; large ones get a cache entry.
      if (Math.max(width, height) <= 1024) {
        return { relativePath, width, height, cached: false };
      }
      const scale = 512 / Math.max(width, height);
      return {
        relativePath: `.app/thumbnails/${revisionOf(relativePath).slice(0, 16)}.png`,
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        cached: true,
      };
    },
    mediaProbe: async (relativePath: string): Promise<MediaProbe> => {
      this.record('media_probe', { relativePath });
      const file = this.check(relativePath);
      const kind = kindOf(relativePath);
      if (kind !== 'audio' && kind !== 'video') {
        throw `file type is not supported: ${relativePath}`;
      }
      const container = relativePath.toLowerCase().split('.').pop() ?? '';
      return {
        relativePath,
        kind,
        container,
        size: file.contents.length,
        strategy: ['mp4', 'm4v', 'webm', 'mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac'].includes(
          container,
        )
          ? 'direct'
          : 'external-player',
      };
    },
    attachmentImport: async (sourcePath: string, targetDirectory: string): Promise<FileFacts> => {
      this.record('attachment_import', { sourcePath, targetDirectory });
      this.open();
      const name = sourcePath.split('/').pop() ?? 'file';
      if (kindOf(name) === 'unsupported') throw `file type is not supported: ${sourcePath}`;
      const relativePath = `${targetDirectory}/${name}`;
      this.write(relativePath, `imported from ${sourcePath}`, { width: 32, height: 32 });
      return this.facts_for(relativePath);
    },

    openUrl: async (url: string): Promise<void> => {
      this.record('external_open_url', { url });
    },
    openPath: async (relativePath: string): Promise<void> => {
      this.record('external_open_path', { relativePath });
      this.check(relativePath);
    },
    revealInFileManager: async (relativePath: string): Promise<void> => {
      this.record('reveal_in_file_manager', { relativePath });
      this.check(relativePath);
    },

    recoveryWrite: async (
      relativePath: string,
      contents: string,
      baseRevision: string,
    ): Promise<void> => {
      this.record('recovery_write', { relativePath, contents, baseRevision });
      this.open();
      this.recovery.set(relativePath, {
        relativePath,
        contents,
        baseRevision,
        savedAtMs: this.recovery.size + 1,
      });
    },
    recoveryList: async (): Promise<RecoveryRecord[]> => {
      this.open();
      return [...this.recovery.values()];
    },
    recoveryClear: async (relativePath: string): Promise<void> => {
      this.record('recovery_clear', { relativePath });
      this.recovery.delete(relativePath);
    },

    toggleFullscreen: async (): Promise<boolean> => {
      this.record('window_toggle_fullscreen', {});
      this.fullscreen = !this.fullscreen;
      return this.fullscreen;
    },
  };
}

/** The one backend every test in a file shares; reset it in `beforeEach`. */
export const backend = new Backend();
export const fakeIpc = backend.ipc;

/** A workspace with one of everything, opened. */
export const openFixtureWorkspace = async (): Promise<void> => {
  backend.give({
    'Notes/note.md': '# Note\n\nA paragraph.\n',
    'notes.txt': 'plain text\n',
    'Canvases/Main.canvas': JSON.stringify({ nodes: [], edges: [] }),
    'Attachments/tiny.mp3': 'ID3 pretend audio',
    'Attachments/tiny.mp4': 'pretend video',
    'Attachments/tiny.mkv': 'pretend matroska',
    'Attachments/doc.pdf': '%PDF-1.4 pretend',
  });
  backend.write('Attachments/square.png', 'pretend png', { width: 64, height: 64 });
  backend.write('Attachments/wide.png', 'pretend png', { width: 2048, height: 512 });
  await fakeIpc.workspaceOpen('/workspace');
};
