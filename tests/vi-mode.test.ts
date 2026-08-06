// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { viLite } from '@/editor/vi-mode';

import { press } from './support/render';

const views: EditorView[] = [];

const editor = (doc: string, line = 1): EditorView => {
  const state = EditorState.create({ doc, extensions: [viLite()] });
  const view = new EditorView({ state, parent: document.body });
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(line).from) });
  views.push(view);
  return view;
};

const cursorLine = (view: EditorView): number =>
  view.state.doc.lineAt(view.state.selection.main.head).number;

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
});

describe('Vi G motions', () => {
  it('moves bare uppercase G to the final line', async () => {
    const view = editor('one\ntwo\n  three');

    await press(view.contentDOM, 'G', { shiftKey: true });

    expect(cursorLine(view)).toBe(3);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from + 2);
  });

  it('uses the number before uppercase G as a one-based line number', async () => {
    const doc = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    const view = editor(doc, 4);

    await press(view.contentDOM, '1');
    await press(view.contentDOM, 'G', { shiftKey: true });
    expect(cursorLine(view)).toBe(1);

    await press(view.contentDOM, '3');
    await press(view.contentDOM, 'G', { shiftKey: true });
    expect(cursorLine(view)).toBe(3);

    await press(view.contentDOM, '1');
    await press(view.contentDOM, '2');
    await press(view.contentDOM, 'G', { shiftKey: true });
    expect(cursorLine(view)).toBe(12);
  });

  it('does not treat lowercase g as the G motion', async () => {
    const view = editor('one\ntwo\nthree', 2);

    await press(view.contentDOM, '1');
    await press(view.contentDOM, 'g');

    expect(cursorLine(view)).toBe(2);
  });
});
