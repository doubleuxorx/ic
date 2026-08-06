/**
 * The events Rust sends the window, and the window it sends them to.
 *
 * The watcher, drag-and-drop and the close request all arrive as Tauri events, so
 * without something to stand in for them none of that behaviour can be reached
 * from a test at all. `emit` delivers to whatever the application is listening
 * for, the way the real event system does.
 */

type Handler = (event: { payload: unknown }) => void;

const handlers = new Map<string, Set<Handler>>();

export const listen = async (name: string, handler: Handler): Promise<() => void> => {
  const existing = handlers.get(name) ?? new Set<Handler>();
  existing.add(handler);
  handlers.set(name, existing);
  return () => existing.delete(handler);
};

export const emit = async (name: string, payload: unknown): Promise<void> => {
  for (const handler of handlers.get(name) ?? []) handler({ payload });
  // Let whatever the handler started finish before a test looks at the result.
  await Promise.resolve();
  await Promise.resolve();
};

export const isListening = (name: string): boolean => (handlers.get(name)?.size ?? 0) > 0;

/** What the application asked the native window to do. */
export const windowCalls = {
  destroyed: 0,
  closeRequests: [] as Array<() => Promise<void>>,
};

export const getCurrentWindow = () => ({
  onCloseRequested: async (handler: (event: { preventDefault: () => void }) => Promise<void>) => {
    windowCalls.closeRequests.push(async () => {
      await handler({ preventDefault: () => undefined });
    });
    return () => undefined;
  },
  destroy: async () => {
    windowCalls.destroyed += 1;
  },
  setFullscreen: async () => undefined,
  isFullscreen: async () => false,
});

/** Ask the window to close, as clicking its close button does. */
export const requestClose = async (): Promise<void> => {
  for (const request of windowCalls.closeRequests) await request();
};

export const resetEvents = (): void => {
  handlers.clear();
  windowCalls.destroyed = 0;
  windowCalls.closeRequests = [];
};
