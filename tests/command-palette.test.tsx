// @vitest-environment jsdom
/**
 * The palette as the user meets it.
 *
 * `tests/commands.test.tsx` runs the commands; this is about reaching them: the
 * search, the keyboard, and the rule that a command which cannot run right now is
 * still visible — a menu that hides what is unavailable teaches nothing about why.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

import { useUiStore } from '@/app/ui-store';
import { CommandPalette } from '@/command-palette/CommandPalette';
import {
  clearCommands,
  registerCommand,
  type AppCommand,
  type CommandContext,
} from '@/command-palette/command-registry';

import { backend } from './support/fake-ipc';
import { cleanup, press, render, settle, type } from './support/render';
import { resetStores } from './support/stores';

const context: CommandContext = {
  workspaceRoot: '/workspace',
  canvasPath: 'Canvases/Main.canvas',
  selection: [],
  selectedEdgeIds: [],
  activeNodeId: null,
  isEditing: false,
};

const ran: string[] = [];

const command = (over: Partial<AppCommand> & { id: string }): AppCommand => ({
  title: over.id,
  category: 'Test',
  isAvailable: () => true,
  execute: () => {
    ran.push(over.id);
  },
  ...over,
});

const items = (host: ParentNode) =>
  [...host.querySelectorAll('.palette-item')].map((item) => ({
    title: item.querySelector('.title')?.textContent ?? '',
    shortcut: item.querySelector('.shortcut')?.textContent ?? null,
    disabled: item.getAttribute('aria-disabled') === 'true',
    active: item.classList.contains('active'),
  }));

const open = async () => {
  const palette = await render(<CommandPalette context={context} />);
  useUiStore.getState().openPalette();
  await settle();
  return palette;
};

beforeEach(() => {
  resetStores();
  backend.reset();
  ran.length = 0;
  clearCommands();
  registerCommand(command({ id: 'add.group', title: 'Add group', category: 'Add' }));
  registerCommand(
    command({ id: 'add.file', title: 'Add file', category: 'Add', defaultShortcut: 'Mod+O' }),
  );
  registerCommand(
    command({
      id: 'edit.delete',
      title: 'Delete',
      category: 'Edit',
      isAvailable: (ctx) => ctx.selection.length > 0,
    }),
  );
  registerCommand(command({ id: 'theme.toggle', title: 'Theme: Toggle', category: 'View' }));
});

afterEach(async () => {
  await cleanup();
});

describe('opening and closing', () => {
  it('shows nothing until it is asked for', async () => {
    const palette = await render(<CommandPalette context={context} />);
    expect(palette.query('.palette')).toBeNull();

    useUiStore.getState().openPalette();
    await settle();
    expect(palette.query('.palette')).not.toBeNull();
  });

  it('closes on Escape without running anything', async () => {
    const palette = await open();

    await press(palette.find('input'), 'Escape');

    expect(useUiStore.getState().paletteOpen).toBe(false);
    expect(ran).toEqual([]);
  });

  it('closes when the backdrop is clicked, and stays open inside it', async () => {
    const palette = await open();

    palette.find('.palette').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(useUiStore.getState().paletteOpen).toBe(true);

    palette.find('.overlay').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it('starts from an empty query each time it opens', async () => {
    const palette = await open();
    await type(palette.find<HTMLInputElement>('input'), 'theme');
    useUiStore.getState().closePalette();
    await settle();

    useUiStore.getState().openPalette();
    await settle();

    expect(palette.find<HTMLInputElement>('input').value).toBe('');
  });
});

describe('finding a command', () => {
  it('lists everything with its category and shortcut before anything is typed', async () => {
    const palette = await open();

    const listed = items(palette.host);
    expect(listed.map((item) => item.title)).toContain('Add group');
    expect(listed.find((item) => item.title === 'Add file')?.shortcut).toMatch(/O$/);
    expect(listed[0]?.active).toBe(true);
  });

  it('filters as the user types', async () => {
    const palette = await open();

    await type(palette.find<HTMLInputElement>('input'), 'add');

    // Which of the two ranks first is the scorer's business; what matters is
    // that nothing else is offered.
    expect(
      items(palette.host)
        .map((item) => item.title)
        .sort(),
    ).toEqual(['Add file', 'Add group']);
  });

  it('says so when nothing matches', async () => {
    const palette = await open();

    await type(palette.find<HTMLInputElement>('input'), 'zzzz');

    expect(palette.text()).toContain('No matching command');
  });

  /** A command that cannot run now still says it exists, and stays last. */
  it('keeps an unavailable command visible, disabled and last', async () => {
    const palette = await open();

    const listed = items(palette.host);
    const deletion = listed.find((item) => item.title === 'Delete');
    expect(deletion?.disabled).toBe(true);
    expect(listed.at(-1)?.title).toBe('Delete');
  });

  it('prefills the query when something asks for a section', async () => {
    const palette = await open();

    window.dispatchEvent(new CustomEvent('ic:palette-query', { detail: 'Theme' }));
    await settle();

    expect(palette.find<HTMLInputElement>('input').value).toBe('Theme');
    expect(items(palette.host).map((item) => item.title)).toEqual(['Theme: Toggle']);
  });
});

describe('running a command', () => {
  it('runs the highlighted one on Enter and closes', async () => {
    const palette = await open();
    const input = palette.find<HTMLInputElement>('input');
    await type(input, 'theme');

    await press(input, 'Enter');

    expect(ran).toEqual(['theme.toggle']);
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it('moves the highlight with the arrow keys', async () => {
    const palette = await open();
    const input = palette.find<HTMLInputElement>('input');
    await type(input, 'add');

    await press(input, 'ArrowDown');
    expect(items(palette.host).findIndex((item) => item.active)).toBe(1);

    await press(input, 'ArrowUp');
    await press(input, 'ArrowUp');
    // The highlight stops at the ends rather than wrapping.
    expect(items(palette.host).findIndex((item) => item.active)).toBe(0);

    // Enter runs whatever is highlighted, which is where the arrows left it.
    const highlighted = items(palette.host).find((item) => item.active)?.title;
    await press(input, 'Enter');
    expect(ran).toHaveLength(1);
    expect(highlighted?.toLowerCase()).toContain(ran[0]?.replace('add.', '') ?? '');
  });

  it('runs the one that is clicked', async () => {
    const palette = await open();

    const clicked = [...palette.host.querySelectorAll('.palette-item')].find(
      (item) => item.querySelector('.title')?.textContent === 'Theme: Toggle',
    );
    clicked?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();

    expect(ran).toEqual(['theme.toggle']);
  });

  it('refuses to run an unavailable one, however it is reached', async () => {
    const palette = await open();
    const input = palette.find<HTMLInputElement>('input');
    await type(input, 'delete');

    await press(input, 'Enter');
    const unavailable = palette.find('.palette-item');
    unavailable.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();

    expect(ran).toEqual([]);
    // It did not close either: nothing happened at all.
    expect(useUiStore.getState().paletteOpen).toBe(true);
  });
});
