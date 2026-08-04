/**
 * Command system.
 *
 * Every significant action is a command. Buttons, keyboard shortcuts and the
 * palette all execute the same registered command, so there is exactly one
 * execution path per action.
 */

import type { CanvasNode } from '@/shared/json-canvas';

export interface CommandContext {
  workspaceRoot: string | null;
  canvasPath: string | null;
  selection: CanvasNode[];
  selectedEdgeIds: string[];
  /** Id of the node currently hosting an editor or an active viewer. */
  activeNodeId: string | null;
  isEditing: boolean;
}

export interface AppCommand {
  id: string;
  title: string;
  category: string;
  defaultShortcut?: string;
  /** Extra words matched by the palette's fuzzy search. */
  aliases?: string[];
  isAvailable: (context: CommandContext) => boolean;
  execute: (context: CommandContext) => void | Promise<void>;
}

const registry = new Map<string, AppCommand>();
const conflicts: string[] = [];

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

/** Canonical form of a shortcut, used for matching and conflict detection. */
export const normalizeShortcut = (shortcut: string): string => {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const modifiers = new Set<string>();
  let key = '';
  for (const part of parts) {
    if (part === 'mod') modifiers.add(isMac() ? 'meta' : 'ctrl');
    else if (['ctrl', 'control'].includes(part)) modifiers.add('ctrl');
    else if (['cmd', 'meta', 'super'].includes(part)) modifiers.add('meta');
    else if (part === 'shift') modifiers.add('shift');
    else if (['alt', 'option'].includes(part)) modifiers.add('alt');
    else key = part;
  }
  const order = ['ctrl', 'meta', 'alt', 'shift'].filter((mod) => modifiers.has(mod));
  return [...order, key].join('+');
};

export const eventShortcut = (event: KeyboardEvent): string => {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.metaKey) modifiers.push('meta');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  return [...modifiers, key].join('+');
};

/** Human-readable shortcut for display. */
export const displayShortcut = (shortcut: string): string =>
  shortcut
    .split('+')
    .map((part) => {
      const lowered = part.trim().toLowerCase();
      if (lowered === 'mod') return isMac() ? 'Cmd' : 'Ctrl';
      if (lowered === 'shift') return 'Shift';
      if (lowered === 'alt') return isMac() ? 'Option' : 'Alt';
      if (lowered === 'ctrl') return 'Ctrl';
      if (lowered === 'meta' || lowered === 'cmd') return 'Cmd';
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('+');

export const registerCommand = (command: AppCommand): void => {
  if (registry.has(command.id)) {
    throw new Error(`duplicate command id: ${command.id}`);
  }
  if (command.defaultShortcut) {
    const normalized = normalizeShortcut(command.defaultShortcut);
    for (const existing of registry.values()) {
      if (
        existing.defaultShortcut &&
        normalizeShortcut(existing.defaultShortcut) === normalized
      ) {
        conflicts.push(`${normalized}: ${existing.id} and ${command.id}`);
      }
    }
  }
  registry.set(command.id, command);
};

export const registerCommands = (commands: AppCommand[]): void => commands.forEach(registerCommand);

export const allCommands = (): AppCommand[] => [...registry.values()];

export const commandById = (id: string): AppCommand | undefined => registry.get(id);

export const shortcutConflicts = (): string[] => [...conflicts];

/** Reset used by tests. */
export const clearCommands = (): void => {
  registry.clear();
  conflicts.length = 0;
};

export const runCommand = async (id: string, context: CommandContext): Promise<void> => {
  const command = registry.get(id);
  if (!command) return;
  if (!command.isAvailable(context)) return;
  await command.execute(context);
};

/** Find the command bound to a keyboard event, if it is currently available. */
export const commandForEvent = (
  event: KeyboardEvent,
  context: CommandContext,
): AppCommand | null => {
  const pressed = eventShortcut(event);
  for (const command of registry.values()) {
    if (!command.defaultShortcut) continue;
    if (normalizeShortcut(command.defaultShortcut) !== pressed) continue;
    return command.isAvailable(context) ? command : null;
  }
  return null;
};

/**
 * Subsequence fuzzy match with a score: earlier and more contiguous matches
 * rank higher. Returns null when the query does not match.
 */
export const fuzzyScore = (query: string, target: string): number | null => {
  if (query.length === 0) return 0;
  const source = target.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let index = 0;
  let previous = -1;
  for (const character of needle) {
    if (character === ' ') continue;
    const found = source.indexOf(character, index);
    if (found === -1) return null;
    score += found === previous + 1 ? 3 : 1;
    if (found === 0 || source[found - 1] === ' ' || source[found - 1] === ':') score += 2;
    previous = found;
    index = found + 1;
  }
  // Prefer shorter titles when scores are otherwise equal.
  return score - target.length * 0.01;
};

export const searchCommands = (
  query: string,
  context: CommandContext,
): { command: AppCommand; available: boolean }[] => {
  const trimmed = query.trim();
  const entries = allCommands().map((command) => ({
    command,
    available: command.isAvailable(context),
    score:
      trimmed.length === 0
        ? 0
        : Math.max(
            fuzzyScore(trimmed, `${command.category}: ${command.title}`) ?? Number.NEGATIVE_INFINITY,
            ...(command.aliases ?? []).map(
              (alias) => fuzzyScore(trimmed, alias) ?? Number.NEGATIVE_INFINITY,
            ),
          ),
  }));

  return entries
    .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.command.title.localeCompare(b.command.title);
    })
    .map(({ command, available }) => ({ command, available }));
};
