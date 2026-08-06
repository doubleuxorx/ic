/**
 * "Vi Lite" — a deliberately small, self-contained modal editing mode.
 *
 * Registers, macros, marks, text objects, operator composition and ex commands
 * are out of scope. The mode lives in a compartment so it can be enabled and
 * disabled without recreating the document.
 *
 * Escape policy: in insert mode Escape switches to normal mode and is consumed,
 * so it never reaches the canvas or a fullscreen handler. In normal mode Escape
 * is passed through, which is what lets a second press leave the editor.
 */

import {
	cursorCharLeft,
	cursorCharRight,
	cursorGroupLeft,
	cursorGroupRight,
	cursorLineBoundaryBackward,
	cursorLineBoundaryForward,
	cursorLineDown,
	cursorLineUp,
	deleteCharForward,
	deleteLine,
	redo,
	selectCharLeft,
	selectCharRight,
	selectGroupLeft,
	selectGroupRight,
	selectLineBoundaryBackward,
	selectLineBoundaryForward,
	selectLineDown,
	selectLineUp,
	undo,
} from "@codemirror/commands";
import {
	EditorSelection,
	Prec,
	StateEffect,
	StateField,
	type EditorState,
	type Extension,
} from "@codemirror/state";
import {
	EditorView,
	ViewPlugin,
	keymap,
	type Command,
	type ViewUpdate,
} from "@codemirror/view";

export type ViMode = "insert" | "normal" | "visual";

interface ViState {
	mode: ViMode;
	/** Pending operator, e.g. the first `d` of `dd`. */
	pending: string;
	/** Decimal line count waiting for an uppercase `G`. */
	count: string;
}

export const setViMode = StateEffect.define<ViMode>();

export const viStateField = StateField.define<ViState>({
	create: () => ({ mode: "normal", pending: "", count: "" }),
	update(value, transaction) {
		let next = value;
		for (const effect of transaction.effects) {
			if (effect.is(setViMode))
				next = { mode: effect.value, pending: "", count: "" };
			if (effect.is(setPending)) next = { ...next, pending: effect.value };
			if (effect.is(setCount)) next = { ...next, count: effect.value };
		}
		return next;
	},
});

const setPending = StateEffect.define<string>();
const setCount = StateEffect.define<string>();

export const viMode = (state: EditorState): ViMode =>
	state.field(viStateField, false)?.mode ?? "insert";

const enter = (view: EditorView, mode: ViMode): boolean => {
	view.dispatch({ effects: setViMode.of(mode) });
	return true;
};

const openLine =
	(below: boolean): Command =>
	(view) => {
		const { state } = view;
		const range = state.selection.main;
		const line = state.doc.lineAt(range.head);
		const position = below ? line.to : line.from;
		const insert = below ? "\n" : "\n";
		view.dispatch({
			changes: { from: position, insert },
			selection: EditorSelection.cursor(below ? position + 1 : position),
			scrollIntoView: true,
		});
		return enter(view, "insert");
	};

/** Uppercase G uses a one-based count, or the final line when no count was given. */
const goToLine = (
	view: EditorView,
	count: string,
	visual: boolean,
): boolean => {
	const requested = count.length > 0 ? Number(count) : view.state.doc.lines;
	const lineNumber = Math.max(1, Math.min(requested, view.state.doc.lines));
	const line = view.state.doc.line(lineNumber);
	const firstNonBlank = line.text.search(/\S/);
	const position = line.from + Math.max(0, firstNonBlank);
	const selection = visual
		? EditorSelection.range(view.state.selection.main.anchor, position)
		: EditorSelection.cursor(position);
	view.dispatch({ selection, effects: setCount.of(""), scrollIntoView: true });
	return true;
};

/** Movement keys, in normal and visual (selection-extending) form. */
const MOTIONS: Record<string, { move: Command; extend: Command }> = {
	h: { move: cursorCharLeft, extend: selectCharLeft },
	l: { move: cursorCharRight, extend: selectCharRight },
	j: { move: cursorLineDown, extend: selectLineDown },
	k: { move: cursorLineUp, extend: selectLineUp },
	w: { move: cursorGroupRight, extend: selectGroupRight },
	b: { move: cursorGroupLeft, extend: selectGroupLeft },
	"0": { move: cursorLineBoundaryBackward, extend: selectLineBoundaryBackward },
	$: { move: cursorLineBoundaryForward, extend: selectLineBoundaryForward },
};

const handleNormalKey = (view: EditorView, event: KeyboardEvent): boolean => {
	const state = view.state.field(viStateField, false);
	if (!state || state.mode === "insert") return false;
	const key = event.key;

	if (event.ctrlKey && (key === "r" || key === "R")) {
		redo(view);
		return true;
	}
	// Other modified keys keep their ordinary CodeMirror behaviour.
	if (event.ctrlKey || event.metaKey || event.altKey) return false;

	const visual = state.mode === "visual";

	if (state.pending === "d") {
		view.dispatch({ effects: setPending.of("") });
		if (key === "d") {
			deleteLine(view);
			return true;
		}
		return true; // an incomplete operator swallows the next key
	}

	const digit = key >= "0" && key <= "9";
	if ((state.count.length > 0 && digit) || (key >= "1" && key <= "9")) {
		view.dispatch({ effects: setCount.of(`${state.count}${key}`) });
		return true;
	}
	if (key === "G") return goToLine(view, state.count, visual);
	if (state.count.length > 0) view.dispatch({ effects: setCount.of("") });

	const motion = MOTIONS[key];
	if (motion) {
		(visual ? motion.extend : motion.move)(view);
		return true;
	}

	switch (key) {
		case "i":
			return enter(view, "insert");
		case "a":
			cursorCharRight(view);
			return enter(view, "insert");
		case "I":
			cursorLineBoundaryBackward(view);
			return enter(view, "insert");
		case "A":
			cursorLineBoundaryForward(view);
			return enter(view, "insert");
		case "o":
			return openLine(true)(view);
		case "O":
			return openLine(false)(view);
		case "x":
			if (visual) {
				view.dispatch(view.state.replaceSelection(""));
				return enter(view, "normal");
			}
			deleteCharForward(view);
			return true;
		case "d":
			if (visual) {
				view.dispatch(view.state.replaceSelection(""));
				return enter(view, "normal");
			}
			view.dispatch({ effects: setPending.of("d") });
			return true;
		case "u":
			undo(view);
			return true;
		case "v":
			return enter(view, visual ? "normal" : "visual");
		case "Escape":
			if (visual) {
				view.dispatch({
					selection: EditorSelection.cursor(view.state.selection.main.head),
				});
				return enter(view, "normal");
			}
			// Normal mode: let the surrounding application decide.
			return false;
		default:
			break;
	}

	// Swallow remaining printable keys so normal mode never inserts text.
	return key.length === 1;
};

/**
 * Publishes the width of the character under the cursor, so the block cursor
 * can cover exactly that character.
 *
 * No CSS length can do this. Live preview uses a proportional face, where every
 * glyph is a different width, and a heading is larger than the body text the
 * cursor element inherits its size from — a fixed `em` measure is wrong on both
 * counts. Measuring keeps CodeMirror's own cursor, and therefore its placement,
 * and only corrects the width.
 */
const blockCursorWidth = ViewPlugin.fromClass(
	class {
		constructor(view: EditorView) {
			this.measure(view);
		}

		update(update: ViewUpdate): void {
			if (update.selectionSet || update.docChanged || update.geometryChanged) {
				this.measure(update.view);
			}
		}

		/** Read and write are split so the measurement never forces a reflow. */
		measure(view: EditorView): void {
			view.requestMeasure<number>({
				read: (instance) => {
					const head = instance.state.selection.main.head;
					const line = instance.state.doc.lineAt(head);
					// Past the last character there is nothing to cover, so the cell
					// before the cursor is measured instead: the block then keeps a full
					// width in the empty cell, which is where a terminal would put it.
					const from = head < line.to ? head : head - 1;
					if (from >= line.from) {
						const start = instance.coordsAtPos(from);
						const end = instance.coordsAtPos(from + 1);
						// Coordinates are already in CSS pixels: CodeMirror divides the
						// canvas zoom out of them. The width is written back inside that
						// same transform, which scales it once, so it lands at the right
						// size. `end` is not to the right of `start` when the next
						// character wrapped onto another line.
						if (start && end && end.left > start.left)
							return end.left - start.left;
					}
					// An empty line has no character on either side of the cursor, so
					// there is nothing to measure and the editor's own character width
					// stands in.
					return instance.defaultCharacterWidth;
				},
				// Always an explicit measurement. Leaving the property unset instead
				// would fall back to a length in the theme, and an `em` there resolves
				// against the cursor element's font size rather than the line's.
				write: (width, instance) => {
					instance.dom.style.setProperty("--vi-cursor-width", `${width}px`);
				},
			});
		}
	},
);

/** Reflects the mode on the editor element so the theme can style the cursor. */
const modeClass = EditorView.updateListener.of((update) => {
	const mode = update.state.field(viStateField, false)?.mode ?? "insert";
	update.view.dom.classList.toggle("vi-normal", mode !== "insert");
});

/** The complete Vi Lite extension. */
export const viLite = (): Extension => [
	viStateField,
	modeClass,
	blockCursorWidth,
	Prec.highest(
		keymap.of([
			{
				key: "Escape",
				run: (view) => {
					const mode = view.state.field(viStateField, false)?.mode ?? "insert";
					if (mode === "insert") return enter(view, "normal");
					return false;
				},
			},
			{
				any: (view, event) => handleNormalKey(view, event),
			},
		]),
	),
];

/** Vi mode is off by default; ordinary editing needs no extension. */
export const viDisabled = (): Extension => [];
