/**
 * What the `Information` command shows.
 *
 * One place to answer "which build is this, and what is it looking at" — the
 * question a bug report has to start with. Debug mode adds the internals that
 * are otherwise noise: where the webview loads files from, and how the media
 * elements are being served.
 */

import { useCanvasStore } from '@/canvas/canvas-store';
import { useEditorSettings } from '@/editor/editor-settings';
import { BUILD } from '@/shared/build-info';
import { isDesktop } from '@/shared/ipc-types';
import { useThemeStore } from '@/theme/theme-store';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { useDebugStore } from './debug-store';
import type { InfoRow } from './ui-store';

const NONE = 'none';

const count = (amount: number, noun: string): string =>
  `${amount} ${noun}${amount === 1 ? '' : 's'}`;

const enabledList = (entries: [string, boolean][]): string =>
  entries
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(', ') || NONE;

export const informationRows = (): InfoRow[] => {
  const { facts, workspace } = useWorkspaceStore.getState();
  const { path, document } = useCanvasStore.getState();
  const debug = useDebugStore.getState().enabled;
  const editor = useEditorSettings.getState();

  const rows: InfoRow[] = [
    // The installed application's own version wins; the bundle's is the answer
    // in a browser, where there is nothing to ask.
    { label: 'Version', value: facts?.version ?? BUILD.version },
    { label: 'Commit', value: BUILD.commit },
    { label: 'Built', value: BUILD.buildTime },
    { label: 'Platform', value: facts?.platform ?? (isDesktop() ? 'desktop' : 'browser') },
    { label: 'Workspace', value: workspace?.root ?? NONE },
    { label: 'Canvas', value: path ?? NONE },
    {
      label: 'Contents',
      value: `${count(document.nodes.length, 'node')}, ${count(document.edges.length, 'edge')}`,
    },
    { label: 'Theme', value: useThemeStore.getState().theme },
    {
      label: 'Editor',
      value: enabledList([
        ['vi mode', editor.viEnabled],
        ['live preview', editor.livePreview],
      ]),
    },
    { label: 'Debug mode', value: debug ? 'on' : 'off' },
  ];

  if (debug) {
    rows.push(
      { label: 'Bundle version', value: BUILD.version },
      { label: 'File protocol', value: facts?.protocolHost ?? NONE },
      { label: 'Media origin', value: facts?.mediaOrigin ?? 'same as file protocol' },
      { label: 'User agent', value: navigator.userAgent },
    );
  }

  return rows;
};
