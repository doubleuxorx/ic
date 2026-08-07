// @vitest-environment jsdom
/**
 * Which build is this, and what is it looking at.
 *
 * The version has to be reachable without a terminal, because the person who
 * needs it is the one reporting a bug: `Information` in the palette answers on
 * demand, and debug mode keeps the answer in the status bar. Both read the same
 * build constants, which vite substitutes at build time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

import { ReactFlowProvider } from '@xyflow/react';

import { useDebugStore } from '@/app/debug-store';
import { DebugStatus } from '@/app/DebugStatus';
import { informationRows } from '@/app/information';
import { ModalHost } from '@/app/ModalHost';
import { showInfo, useUiStore } from '@/app/ui-store';
import { useCanvasStore } from '@/canvas/canvas-store';
import { BUILD, versionLabel } from '@/shared/build-info';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { button, cleanup, click, render } from './support/render';
import { resetStores } from './support/stores';

const label = (name: string): string | undefined =>
  informationRows().find((row) => row.label === name)?.value;

beforeEach(async () => {
  resetStores();
  backend.reset();
  await openFixtureWorkspace();
});

afterEach(async () => {
  await cleanup();
  resetStores();
});

describe('the information the application knows about itself', () => {
  it('reports the build even with nothing open', () => {
    expect(label('Version')).toBe(BUILD.version);
    expect(label('Commit')).toBe(BUILD.commit);
    expect(label('Built')).toBe(BUILD.buildTime);
    expect(label('Workspace')).toBe('none');
    expect(label('Canvas')).toBe('none');
  });

  it('prefers the version the installed application reports', async () => {
    backend.facts.version = '9.9.9';
    await useWorkspaceStore.getState().loadFacts();
    expect(label('Version')).toBe('9.9.9');
    // The bundle's own version is still the commit's companion.
    expect(label('Commit')).toBe(BUILD.commit);
  });

  it('names what is open', async () => {
    await useWorkspaceStore.getState().open('/workspace');
    await useCanvasStore.getState().load('Canvases/Main.canvas');

    expect(label('Workspace')).toBe('/workspace');
    expect(label('Canvas')).toBe('Canvases/Main.canvas');
    expect(label('Contents')).toBe('0 nodes, 0 edges');
  });

  it('counts one of something as one', () => {
    useCanvasStore.setState({
      document: {
        nodes: [{ id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
        edges: [{ id: 'e', fromNode: 'a', toNode: 'a' }],
      },
    });
    expect(label('Contents')).toBe('1 node, 1 edge');
  });

  it('adds the internals only while debugging', () => {
    expect(label('Media origin')).toBeUndefined();
    expect(label('Debug mode')).toBe('off');

    useDebugStore.getState().set(true);

    expect(label('Debug mode')).toBe('on');
    expect(label('Media origin')).toBeDefined();
    expect(label('File protocol')).toBeDefined();
  });
});

describe('the information panel', () => {
  it('lists what it was given and closes without answering anything', async () => {
    const asked = showInfo('Information', [
      { label: 'Version', value: '1.2.3' },
      { label: 'Commit', value: 'abc1234' },
    ]);
    const view = await render(<ModalHost />);

    const labels = [...view.host.querySelectorAll('dt')].map((node) => node.textContent);
    const values = [...view.host.querySelectorAll('dd')].map((node) => node.textContent);
    expect(labels).toEqual(['Version', 'Commit']);
    expect(values).toEqual(['1.2.3', 'abc1234']);

    await click(button(view.host, 'Close'));
    expect(await asked).toBeNull();
    expect(useUiStore.getState().modal).toBeNull();
  });

  it('copies itself for a bug report', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    void showInfo('Information', [{ label: 'Version', value: '1.2.3' }]);
    const view = await render(<ModalHost />);
    await click(button(view.host, 'Copy'));

    expect(writeText).toHaveBeenCalledWith('Version: 1.2.3');
  });
});

describe('the debug status bar', () => {
  it('shows the build, the size of the canvas and the zoom', async () => {
    useCanvasStore.setState({
      document: {
        nodes: [
          { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
          { id: 'b', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
        ],
        edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
      },
    });

    const view = await render(
      <ReactFlowProvider>
        <DebugStatus />
      </ReactFlowProvider>,
    );

    expect(view.text()).toContain(versionLabel());
    expect(view.text()).toContain('2n 1e');
    expect(view.text()).toContain('100%');
  });
});
