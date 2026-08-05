/**
 * Live preview — Markdown that reads as prose everywhere except where you type.
 *
 * Syntax markers (`#`, `**`, backticks, link brackets and URLs) are hidden on
 * every line the selection does not touch; the line under the cursor always
 * shows its raw source, so editing is never done blind.
 *
 * That rule is also what keeps the extension simple. A cursor can only ever sit
 * on a line whose markers are visible, so no cursor position is ever inside a
 * hidden range and none of the usual machinery for replaced text — atomic
 * ranges, mapping a click back to an offset — is needed. Motion, selection,
 * copy and undo behave exactly as they do on plain source.
 *
 * Styling (heading size, bold, code) is applied to every line including the
 * active one. Only the markers appear and disappear, so moving the cursor
 * between lines never changes their height.
 *
 * Nothing here renders HTML: the document remains its own source text. Tables,
 * images and fenced code are deliberately left as Markdown, because showing
 * them any other way means replacing a block with rendered output, which is a
 * different and much larger feature.
 */

import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
/**
 * The part of a syntax node this file needs. Declared structurally rather than
 * imported from `@lezer/common`, which reaches the build only as a dependency
 * of the CodeMirror packages.
 */
interface Ancestor {
  name: string;
  parent: Ancestor | null;
}

/** A half-open document range. */
interface Span {
  from: number;
  to: number;
}

/** What the preview wants drawn, as plain data so it can be tested directly. */
export interface PreviewMarkup {
  /** Syntax characters to make invisible, because the cursor is elsewhere. */
  hidden: Span[];
  /** Inline spans carrying a class, applied whatever the cursor is doing. */
  spans: (Span & { className: string })[];
  /** Whole-line classes, anchored at each line's start offset. */
  lines: { at: number; className: string }[];
}

const HEADING_LEVEL: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

const INLINE_CLASS: Record<string, string> = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  Strikethrough: 'cm-md-strike',
  InlineCode: 'cm-md-code',
  Link: 'cm-md-link',
};

/**
 * Image syntax is left alone: hiding `![alt](src)` down to its alt text would
 * claim a picture is being shown when none is. Link marks nested inside an
 * image belong to the image, so ancestry decides rather than the parent alone.
 */
const insideImage = (node: { node: Ancestor }): boolean => {
  for (let cursor = node.node.parent; cursor; cursor = cursor.parent) {
    if (cursor.name === 'Image') return true;
    if (cursor.name === 'Link') return false;
  }
  return false;
};

/** Offset ranges of every line touched by the selection. */
const activeLineSpans = (state: EditorState): Span[] => {
  const spans: Span[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    const last = range.to === range.from ? first : state.doc.lineAt(range.to);
    const previous = spans[spans.length - 1];
    // Ranges arrive in document order, so touching spans can be merged.
    if (previous && first.from <= previous.to) previous.to = Math.max(previous.to, last.to);
    else spans.push({ from: first.from, to: last.to });
  }
  return spans;
};

const overlaps = (spans: Span[], from: number, to: number): boolean =>
  spans.some((span) => from <= span.to && to >= span.from);

/** Marker hiding swallows the space that separates it from the content. */
const withTrailingSpace = (state: EditorState, to: number): number => {
  let end = to;
  while (end < state.doc.length && state.doc.sliceString(end, end + 1) === ' ') end += 1;
  return end;
};

/**
 * Work out the decorations for `ranges` (normally the viewport) as plain data.
 *
 * Exported separately from the extension so it can be exercised without a
 * layout: everything below this function is bookkeeping.
 */
export const markupFor = (
  state: EditorState,
  ranges: readonly Span[] = [{ from: 0, to: state.doc.length }],
): PreviewMarkup => {
  const markup: PreviewMarkup = { hidden: [], spans: [], lines: [] };
  const active = activeLineSpans(state);
  const tree = syntaxTree(state);

  const hide = (from: number, to: number): void => {
    if (from >= to || overlaps(active, from, to)) return;
    markup.hidden.push({ from, to });
  };

  // The active line is raw Markdown, so it is set as source: the monospace face
  // both signals that and gives every character the same advance, which is what
  // makes the Vi block cursor a consistent width instead of tracking the width
  // of whichever proportional glyph it happens to sit on.
  for (const span of active) {
    for (let at = span.from; at <= span.to; ) {
      const line = state.doc.lineAt(at);
      if (ranges.some((range) => line.from <= range.to && line.to >= range.from)) {
        markup.lines.push({ at: line.from, className: 'cm-md-source' });
      }
      at = line.to + 1;
    }
  }

  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const level = HEADING_LEVEL[node.name];
        if (level !== undefined) {
          markup.lines.push({
            at: state.doc.lineAt(node.from).from,
            className: `cm-md-h${level}`,
          });
          return true;
        }

        const inline = INLINE_CLASS[node.name];
        if (inline) {
          markup.spans.push({ from: node.from, to: node.to, className: inline });
          return true;
        }

        switch (node.name) {
          case 'Blockquote': {
            markup.spans.push({ from: node.from, to: node.to, className: 'cm-md-quote' });
            for (let at = node.from; at <= node.to; ) {
              const line = state.doc.lineAt(at);
              markup.lines.push({ at: line.from, className: 'cm-md-quote-line' });
              at = line.to + 1;
            }
            return true;
          }

          case 'HeaderMark':
            // ATX only. A Setext underline is a line of its own, and hiding it
            // would leave a blank one behind — worse than showing `===`.
            if (node.node.parent?.name.startsWith('ATXHeading')) {
              hide(node.from, withTrailingSpace(state, node.to));
            }
            return false;

          case 'QuoteMark':
            hide(node.from, withTrailingSpace(state, node.to));
            return false;

          case 'EmphasisMark':
          case 'StrikethroughMark':
            hide(node.from, node.to);
            return false;

          case 'CodeMark':
            // Backticks around inline code. The same node names the fences of a
            // fenced block, which stays visible.
            if (node.node.parent?.name === 'InlineCode') hide(node.from, node.to);
            return false;

          case 'LinkMark':
          case 'URL':
          case 'LinkTitle':
            if (!insideImage(node)) hide(node.from, node.to);
            return false;

          case 'ListMark':
            markup.spans.push({ from: node.from, to: node.to, className: 'cm-md-list-mark' });
            return false;

          case 'HorizontalRule':
            markup.spans.push({ from: node.from, to: node.to, className: 'cm-md-hr' });
            return false;

          default:
            return true;
        }
      },
    });
  }

  return markup;
};

const hiddenMark = Decoration.replace({});

const toDecorations = (markup: PreviewMarkup): DecorationSet => {
  const ranges: Range<Decoration>[] = [];
  for (const span of markup.hidden) ranges.push(hiddenMark.range(span.from, span.to));
  for (const span of markup.spans) {
    if (span.from >= span.to) continue;
    ranges.push(Decoration.mark({ class: span.className }).range(span.from, span.to));
  }
  for (const line of markup.lines) {
    ranges.push(Decoration.line({ class: line.className }).range(line.at));
  }
  // Sorting is left to the range set: the tree yields parents before children.
  return Decoration.set(ranges, true);
};

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = toDecorations(markupFor(view.state, view.visibleRanges));
    }

    update(update: ViewUpdate): void {
      // Selection changes matter as much as edits here: moving the cursor onto
      // a line is what reveals its markers.
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = toDecorations(markupFor(update.state, update.view.visibleRanges));
      }
    }
  },
  { decorations: (value) => value.decorations },
);

/**
 * The complete live preview extension.
 *
 * The `md-live` class lets the theme switch the editor to a proportional face
 * while the mode is on, without touching plain source editing.
 */
export const livePreview = (): Extension => [
  plugin,
  EditorView.editorAttributes.of({ class: 'md-live' }),
];
