// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearCommands,
  commandForEvent,
  fuzzyScore,
  normalizeShortcut,
  registerCommand,
  runCommand,
  searchCommands,
  shortcutConflicts,
  type AppCommand,
  type CommandContext,
} from '@/command-palette/command-registry';

const context = (over: Partial<CommandContext> = {}): CommandContext => ({
  workspaceRoot: '/tmp/workspace',
  canvasPath: 'Canvases/Main.canvas',
  selection: [],
  selectedEdgeIds: [],
  activeNodeId: null,
  isEditing: false,
  ...over,
});

const command = (over: Partial<AppCommand> & { id: string }): AppCommand => ({
  title: over.id,
  category: 'Test',
  isAvailable: () => true,
  execute: () => undefined,
  ...over,
});

describe('command registry', () => {
  beforeEach(() => clearCommands());

  it('normalizes shortcuts to one canonical form', () => {
    expect(normalizeShortcut('Ctrl+Shift+P')).toBe(normalizeShortcut('shift+control+p'));
    expect(normalizeShortcut('Mod+S')).toMatch(/\+s$/);
  });

  it('detects shortcut conflicts', () => {
    registerCommand(command({ id: 'one', defaultShortcut: 'Mod+K' }));
    registerCommand(command({ id: 'two', defaultShortcut: 'Mod+K' }));
    expect(shortcutConflicts()).toHaveLength(1);
    expect(shortcutConflicts()[0]).toContain('one');
    expect(shortcutConflicts()[0]).toContain('two');
  });

  it('rejects duplicate command ids', () => {
    registerCommand(command({ id: 'dup' }));
    expect(() => registerCommand(command({ id: 'dup' }))).toThrow();
  });

  it('runs a command only when it is available in the given context', () => {
    const execute = vi.fn();
    registerCommand(
      command({
        id: 'needs.selection',
        isAvailable: (ctx) => ctx.selection.length > 0,
        execute,
      }),
    );
    void runCommand('needs.selection', context());
    expect(execute).not.toHaveBeenCalled();

    void runCommand(
      'needs.selection',
      context({
        selection: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1 }],
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('maps a keyboard event to its command', () => {
    registerCommand(command({ id: 'save', defaultShortcut: 'Ctrl+S' }));
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true });
    expect(commandForEvent(event, context())?.id).toBe('save');

    const wrong = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, shiftKey: true });
    expect(commandForEvent(wrong, context())).toBeNull();
  });

  it('returns null for a matched shortcut whose command is unavailable', () => {
    registerCommand(
      command({ id: 'unavailable', defaultShortcut: 'Ctrl+U', isAvailable: () => false }),
    );
    const event = new KeyboardEvent('keydown', { key: 'u', ctrlKey: true });
    expect(commandForEvent(event, context())).toBeNull();
  });

  it('ranks fuzzy matches and keeps unavailable commands visible but last', () => {
    registerCommand(command({ id: 'a', title: 'Add group', category: 'Add' }));
    registerCommand(
      command({ id: 'b', title: 'Add file', category: 'Add', isAvailable: () => false }),
    );
    registerCommand(command({ id: 'c', title: 'Toggle theme', category: 'View' }));

    const results = searchCommands('add', context());
    expect(results[0]?.command.id).toBe('a');
    expect(results.at(-1)?.available).toBe(false);
    expect(results.some((entry) => entry.command.id === 'c')).toBe(false);
  });

  it('scores contiguous and word-start matches higher', () => {
    const contiguous = fuzzyScore('theme', 'Theme: Toggle') ?? 0;
    const scattered = fuzzyScore('theme', 'The middle element') ?? 0;
    expect(contiguous).toBeGreaterThan(scattered);
    expect(fuzzyScore('zzz', 'Theme: Toggle')).toBeNull();
  });
});
