import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { markupFor } from '@/editor/live-preview';

/** Matches the editor's own configuration, GFM base included. */
const language = markdown({ base: markdownLanguage });

const stateFor = (doc: string, cursor: number): EditorState =>
  EditorState.create({ doc, extensions: [language], selection: { anchor: cursor } });

/** The source text of everything the preview would make invisible. */
const hiddenIn = (doc: string, cursor: number): string[] => {
  const state = stateFor(doc, cursor);
  return markupFor(state).hidden.map((span) => state.doc.sliceString(span.from, span.to));
};

const classesIn = (doc: string, cursor: number): string[] =>
  markupFor(stateFor(doc, cursor)).spans.map((span) => span.className);

/** A cursor parked on a trailing blank line leaves every other line inactive. */
const AWAY = (doc: string): number => doc.length;

describe('live preview markup', () => {
  it('hides heading markers, with the space that follows them', () => {
    const doc = '# Title\n\ntext';
    expect(hiddenIn(doc, AWAY(doc))).toEqual(['# ']);
    expect(markupFor(stateFor(doc, AWAY(doc))).lines).toContainEqual({
      at: 0,
      className: 'cm-md-h1',
    });
  });

  it('shows the raw source of the line the cursor is on, and only that line', () => {
    const doc = '# Title\n\n**bold** here';
    // Cursor inside the heading: its `# ` is back, the bold markers stay hidden.
    expect(hiddenIn(doc, 3)).toEqual(['**', '**']);
    // The heading keeps its size while being edited, so the line cannot jump.
    expect(markupFor(stateFor(doc, 3)).lines).toContainEqual({ at: 0, className: 'cm-md-h1' });
  });

  it('hides emphasis, strikethrough and inline code markers', () => {
    const doc = 'a **b** c *d* e ~~f~~ g `h`\n\n';
    expect(hiddenIn(doc, AWAY(doc))).toEqual(['**', '**', '*', '*', '~~', '~~', '`', '`']);
    expect(classesIn(doc, AWAY(doc))).toEqual(
      expect.arrayContaining(['cm-md-strong', 'cm-md-em', 'cm-md-strike', 'cm-md-code']),
    );
  });

  it('hides link brackets and the address, keeping the label', () => {
    const doc = 'see [the page](https://example.org/x) now\n\n';
    expect(hiddenIn(doc, AWAY(doc)).join('')).toBe('[](https://example.org/x)');
  });

  it('leaves image syntax alone, including its nested marks', () => {
    const doc = '![alt](picture.png)\n\n';
    expect(hiddenIn(doc, AWAY(doc))).toEqual([]);
  });

  it('leaves fenced code fences visible', () => {
    const doc = '```js\nconst a = 1;\n```\n\n';
    expect(hiddenIn(doc, AWAY(doc))).toEqual([]);
  });

  it('hides quote markers and marks the quoted lines', () => {
    const doc = '> quoted\n> more\n\ntext';
    const markup = markupFor(stateFor(doc, AWAY(doc)));
    expect(hiddenIn(doc, AWAY(doc))).toEqual(['> ', '> ']);
    expect(markup.lines.filter((line) => line.className === 'cm-md-quote-line')).toHaveLength(2);
  });

  it('keeps list markers visible, styled only', () => {
    const doc = '- one\n- two\n\n';
    expect(hiddenIn(doc, AWAY(doc))).toEqual([]);
    expect(classesIn(doc, AWAY(doc)).filter((name) => name === 'cm-md-list-mark')).toHaveLength(2);
  });

  it('marks exactly the revealed lines as source', () => {
    const doc = '# Title\n\n**bold** here\n';
    const sourceLines = (cursor: number): number[] =>
      markupFor(stateFor(doc, cursor))
        .lines.filter((line) => line.className === 'cm-md-source')
        .map((line) => line.at);

    expect(sourceLines(3)).toEqual([0]);
    expect(sourceLines(doc.indexOf('bold'))).toEqual([doc.indexOf('**bold**')]);
  });

  it('reveals every line a selection spans, not just its ends', () => {
    const doc = '# One\n**two**\n*three*\n\ntext';
    const state = EditorState.create({
      doc,
      extensions: [language],
      selection: { anchor: 2, head: doc.indexOf('*three*') + 2 },
    });
    expect(markupFor(state).hidden).toEqual([]);
  });

  /**
   * The property the whole design rests on: because the cursor's line is never
   * decorated, no cursor position can land inside hidden text. That is what
   * makes atomic ranges and click-to-offset mapping unnecessary.
   */
  it('never hides text at the cursor, wherever the cursor is', () => {
    const doc = '# Title\n\nSome **bold** and `code` and [a link](https://example.org).\n\n> quote\n';
    for (let cursor = 0; cursor <= doc.length; cursor += 1) {
      const spans = markupFor(stateFor(doc, cursor)).hidden;
      for (const span of spans) {
        expect(cursor > span.from && cursor < span.to).toBe(false);
      }
    }
  });
});
