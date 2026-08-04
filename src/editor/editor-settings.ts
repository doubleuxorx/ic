/** Editor preferences that are not part of any document. */

import { create } from 'zustand';

const STORAGE_KEY = 'ic.editor';

interface Persisted {
  viEnabled: boolean;
}

const read = (): Persisted => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      return { viEnabled: parsed.viEnabled === true };
    }
  } catch {
    // Fall through to defaults.
  }
  return { viEnabled: false };
};

interface EditorSettings extends Persisted {
  setViEnabled: (enabled: boolean) => void;
  toggleVi: () => void;
}

export const useEditorSettings = create<EditorSettings>((set, get) => ({
  ...read(),
  setViEnabled: (viEnabled) => {
    set({ viEnabled });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ viEnabled }));
    } catch {
      // Best effort.
    }
  },
  toggleVi: () => get().setViEnabled(!get().viEnabled),
}));
