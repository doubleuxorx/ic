/** Editor preferences that are not part of any document. */

import { create } from 'zustand';

const STORAGE_KEY = 'ic.editor';

interface Persisted {
  viEnabled: boolean;
  /** Hide Markdown syntax on lines the cursor is not on. On by default. */
  livePreview: boolean;
}

const read = (): Persisted => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      return {
        viEnabled: parsed.viEnabled === true,
        livePreview: parsed.livePreview !== false,
      };
    }
  } catch {
    // Fall through to defaults.
  }
  return { viEnabled: false, livePreview: true };
};

interface EditorSettings extends Persisted {
  setViEnabled: (enabled: boolean) => void;
  toggleVi: () => void;
  setLivePreview: (enabled: boolean) => void;
  toggleLivePreview: () => void;
}

export const useEditorSettings = create<EditorSettings>((set, get) => ({
  ...read(),
  setViEnabled: (viEnabled) => {
    set({ viEnabled });
    persist(get());
  },
  toggleVi: () => get().setViEnabled(!get().viEnabled),
  setLivePreview: (livePreview) => {
    set({ livePreview });
    persist(get());
  },
  toggleLivePreview: () => get().setLivePreview(!get().livePreview),
}));

const persist = ({ viEnabled, livePreview }: Persisted): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ viEnabled, livePreview }));
  } catch {
    // Best effort.
  }
};
