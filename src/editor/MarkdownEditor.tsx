/**
 * CodeMirror host.
 *
 * Mounted only for the node currently being edited: previews elsewhere stay
 * lightweight HTML. Wheel and pointer events are kept away from the canvas so
 * editing never fights panning, zooming or dragging.
 */

import { useEffect, useRef, useState } from 'react';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';

import { createEchoGuard, noteLocalEdit, shouldAdopt } from './echo-guard';
import { useEditorSettings } from './editor-settings';
import { viLite, viMode, type ViMode } from './vi-mode';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Leaving the editor: Escape in normal mode, or Ctrl/Cmd+Enter. */
  onExit: () => void;
  onSave?: () => void;
  autoFocus?: boolean;
}

const viCompartment = new Compartment();

export const MarkdownEditor = ({ value, onChange, onExit, onSave, autoFocus = true }: Props) => {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const echoes = useRef(createEchoGuard()).current;
  const [mode, setMode] = useState<ViMode>('insert');
  const viEnabled = useEditorSettings((state) => state.viEnabled);

  useEffect(() => {
    if (!host.current) return undefined;

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              onSave?.();
              return true;
            },
          },
          {
            key: 'Mod-Enter',
            run: () => {
              onExit();
              return true;
            },
          },
          {
            key: 'Escape',
            run: () => {
              // Vi insert mode consumes Escape first; this only runs when the
              // editor is not modal or is already in normal mode.
              onExit();
              return true;
            },
          },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        viCompartment.of(useEditorSettings.getState().viEnabled ? viLite() : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            noteLocalEdit(echoes);
            onChange(update.state.doc.toString());
          }
          setMode(viMode(update.state));
        }),
      ],
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    if (autoFocus) instance.focus();
    setMode(viMode(instance.state));

    return () => {
      instance.destroy();
      view.current = null;
    };
    // The editor is created once per mounted node; value updates are handled
    // by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggling Vi mode reconfigures the compartment; the document is untouched.
  useEffect(() => {
    view.current?.dispatch({
      effects: viCompartment.reconfigure(viEnabled ? viLite() : []),
    });
  }, [viEnabled]);

  // Adopt external edits without disturbing an in-progress local edit.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (!shouldAdopt(echoes, value, current)) return;
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div
      className="editor-host nodrag nowheel nopan"
      ref={host}
      onPointerDownCapture={(event) => event.stopPropagation()}
      // Key events are deliberately not intercepted here. React dispatches its
      // capture-phase handlers from the root container, and stopping one there
      // stops the native event too, so CodeMirror below would never see the
      // key at all. Canvas shortcuts are suppressed instead by the routing in
      // `App`, which ignores keys aimed at a text entry.
    >
      {viEnabled ? <span className="vi-indicator">{mode.toUpperCase()}</span> : null}
    </div>
  );
};
