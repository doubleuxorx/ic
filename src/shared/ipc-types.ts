/**
 * The only place the frontend talks to Rust.
 *
 * Every function here maps to one narrow command. Nothing in the UI calls
 * `invoke` directly, so the full privileged surface is visible in this file.
 */

import { invoke } from '@tauri-apps/api/core';

export type FileKind =
  | 'markdown'
  | 'canvas'
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'text'
  | 'unsupported';

export interface WorkspaceInfo {
  root: string;
  name: string;
}

export interface FileEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  kind: FileKind;
  size: number;
  modifiedMs: number;
  children?: FileEntry[];
}

export interface DocumentContent {
  relativePath: string;
  contents: string;
  revision: string;
  modifiedMs: number;
}

export interface WriteResult {
  relativePath: string;
  revision: string;
  modifiedMs: number;
}

export interface FileFacts {
  relativePath: string;
  kind: FileKind;
  size: number;
  modifiedMs: number;
  width: number | null;
  height: number | null;
  external: boolean;
}

export interface Thumbnail {
  relativePath: string;
  width: number;
  height: number;
  cached: boolean;
}

export interface MediaProbe {
  relativePath: string;
  kind: FileKind;
  container: string;
  size: number;
  strategy: 'direct' | 'external-player';
}

export interface RecoveryRecord {
  relativePath: string;
  contents: string;
  baseRevision: string;
  savedAtMs: number;
}

export interface WorkspaceSettings {
  lastCanvas: string | null;
  viewports: Record<string, { x: number; y: number; zoom: number }>;
  authorizedExternalPaths: string[];
  ui: Record<string, unknown>;
}

export interface AppFacts {
  protocolScheme: string;
  protocolHost: string;
  platform: string;
  version: string;
  /** Directory named on the command line, e.g. `ic ~/notes`. */
  initialWorkspace: string | null;
}

export interface ChangeEvent {
  paths: string[];
}

export const ipc = {
  appFacts: () => invoke<AppFacts>('app_facts'),

  workspaceOpen: (path: string) => invoke<WorkspaceInfo>('workspace_open', { path }),
  workspaceClose: () => invoke<void>('workspace_close'),
  workspaceTree: () => invoke<FileEntry[]>('workspace_tree'),
  workspaceCreateDirectory: (relativePath: string) =>
    invoke<void>('workspace_create_directory', { relativePath }),
  settingsRead: () => invoke<WorkspaceSettings>('workspace_settings_read'),
  settingsWrite: (settings: WorkspaceSettings) =>
    invoke<void>('workspace_settings_write', { settings }),
  authorizeExternal: (path: string) => invoke<string[]>('workspace_authorize_external', { path }),

  documentRead: (relativePath: string) => invoke<DocumentContent>('document_read', { relativePath }),
  documentWrite: (relativePath: string, expectedRevision: string, contents: string) =>
    invoke<WriteResult>('document_write', { relativePath, expectedRevision, contents }),
  documentCreate: (relativePath: string, contents: string) =>
    invoke<WriteResult>('document_create', { relativePath, contents }),

  fileFacts: (relativePath: string) => invoke<FileFacts>('file_facts', { relativePath }),
  thumbnailRequest: (relativePath: string) => invoke<Thumbnail>('thumbnail_request', { relativePath }),
  mediaProbe: (relativePath: string) => invoke<MediaProbe>('media_probe', { relativePath }),
  attachmentImport: (sourcePath: string, targetDirectory: string) =>
    invoke<FileFacts>('attachment_import', { request: { sourcePath, targetDirectory } }),

  openUrl: (url: string) => invoke<void>('external_open_url', { url }),
  openPath: (relativePath: string) => invoke<void>('external_open_path', { relativePath }),
  revealInFileManager: (relativePath: string) =>
    invoke<void>('reveal_in_file_manager', { relativePath }),

  recoveryWrite: (relativePath: string, contents: string, baseRevision: string) =>
    invoke<void>('recovery_write', { relativePath, contents, baseRevision }),
  recoveryList: () => invoke<RecoveryRecord[]>('recovery_list'),
  recoveryClear: (relativePath: string) => invoke<void>('recovery_clear', { relativePath }),

  toggleFullscreen: () => invoke<boolean>('window_toggle_fullscreen'),
};

/** True when running inside the Tauri webview rather than a plain browser. */
export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
