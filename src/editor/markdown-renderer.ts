/**
 * Markdown rendering.
 *
 * Raw HTML is disabled in the parser and the result is sanitized again before
 * it reaches the DOM. Links are rendered inert: the href is moved to a data
 * attribute so a stray click can never navigate the webview, and opening one
 * requires the deliberate action wired up in the node components.
 *
 * Images resolve to workspace files through the local `ic://` protocol; remote
 * image URLs are dropped rather than fetched, because the application never
 * touches the network.
 */

import MarkdownIt, { type StateCore } from 'markdown-it';
import DOMPurify from 'dompurify';

import { fileUrl } from '@/workspace/workspace-store';

const md = new MarkdownIt({
  html: false, // no raw HTML by default
  linkify: true,
  breaks: false,
  typographer: false,
});

/** A `[ ]` or `[x]` opening a list item, up to the space that follows it. */
const TASK_MARKER = /^\[([ xX])\](?=$|\s)/;

/**
 * Task lists: `- [ ]` and `- [x]`.
 *
 * markdown-it leaves the brackets as ordinary text, so the marker is lifted out
 * of the item's first paragraph and replaced by a token drawn as a box. It is
 * drawn rather than an `<input type="checkbox">` because form controls do not
 * survive sanitizing, and the preview is read-only in any case: a note's boxes
 * are ticked by editing the note.
 */
const taskLists = (state: StateCore): void => {
  const { tokens } = state;
  for (let index = 2; index < tokens.length; index += 1) {
    // Only the paragraph a list item opens with carries a marker; brackets
    // anywhere else in the item are ordinary text.
    const inline = tokens[index];
    if (inline?.type !== 'inline') continue;
    if (tokens[index - 1]?.type !== 'paragraph_open') continue;
    const item = tokens[index - 2];
    if (item?.type !== 'list_item_open') continue;

    // A first child that is not text means the brackets were parsed as
    // something else — a reference link, say — and are not a task marker.
    const first = inline.children?.[0];
    if (first?.type !== 'text') continue;
    const match = TASK_MARKER.exec(first.content);
    if (!match) continue;

    const strip = (text: string): string => text.slice(match[0].length).replace(/^[ \t]+/, '');
    first.content = strip(first.content);
    inline.content = strip(inline.content);

    const box = new state.Token('task_checkbox', '', 0);
    box.meta = { checked: match[1] !== ' ' };
    inline.children?.unshift(box);
    item.attrJoin('class', 'task-item');
  }
};

md.core.ruler.after('inline', 'task_lists', taskLists);

md.renderer.rules.task_checkbox = (tokens, index) => {
  const checked = (tokens[index]?.meta as { checked?: boolean } | undefined)?.checked === true;
  const classes = checked ? 'task-box checked' : 'task-box';
  return `<span class="${classes}" role="checkbox" aria-checked="${checked}" aria-disabled="true"></span>`;
};

const ALLOWED_LINK_SCHEMES = ['http://', 'https://', 'mailto:'];

const isSafeLink = (value: string): boolean => {
  const lowered = value.trim().toLowerCase();
  return ALLOWED_LINK_SCHEMES.some((scheme) => lowered.startsWith(scheme));
};

const isRelative = (value: string): boolean =>
  !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//') && !value.startsWith('/');

let hooksInstalled = false;

/** Base directory of the note being rendered, used to resolve relative images. */
let currentBase = '';

const installHooks = (): void => {
  if (hooksInstalled) return;
  hooksInstalled = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;

    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      node.removeAttribute('href');
      node.removeAttribute('target');
      node.removeAttribute('rel');
      if (isSafeLink(href)) {
        node.setAttribute('data-href', href);
        node.setAttribute('class', 'md-link');
        node.setAttribute('role', 'link');
        node.setAttribute('tabindex', '0');
      }
      return;
    }

    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      if (isRelative(src)) {
        const resolved = currentBase ? `${currentBase}/${src}` : src;
        // Normalize `./` and `../` against the note's directory.
        const parts: string[] = [];
        for (const part of resolved.split('/')) {
          if (part === '' || part === '.') continue;
          if (part === '..') parts.pop();
          else parts.push(part);
        }
        node.setAttribute('src', fileUrl(parts.join('/')));
      } else {
        // Remote or data images are not loaded.
        node.removeAttribute('src');
        node.setAttribute('alt', node.getAttribute('alt') ?? '');
      }
      node.setAttribute('loading', 'lazy');
    }
  });
};

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span', 'div', 'sup', 'sub',
  ],
  // `role` is here for the task list boxes, which have no text of their own to
  // announce. It carries no behaviour, and raw HTML never reaches the parser,
  // so the only roles that can appear are the ones the renderer writes.
  ALLOWED_ATTR: ['src', 'alt', 'title', 'href', 'class', 'align', 'colspan', 'rowspan', 'role'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math'],
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'ping'],
  USE_PROFILES: { html: true },
};

/**
 * Render Markdown to sanitized HTML.
 *
 * `baseDirectory` is the workspace-relative directory of the source file, used
 * to resolve relative image paths.
 */
export const renderMarkdown = (source: string, baseDirectory = ''): string => {
  installHooks();
  currentBase = baseDirectory;
  const html = md.render(source ?? '');
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
};

/** Extract the section under a `#heading` subpath, as JSON Canvas file nodes use. */
export const sliceSubpath = (source: string, subpath: string | undefined): string => {
  if (!subpath) return source;
  const heading = subpath.replace(/^#+/, '').trim().toLowerCase();
  if (heading.length === 0) return source;
  const lines = source.split('\n');
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index] ?? '');
    if (!match) continue;
    if (start === -1 && (match[2] ?? '').trim().toLowerCase() === heading) {
      start = index;
      level = (match[1] ?? '').length;
    } else if (start !== -1 && (match[1] ?? '').length <= level) {
      return lines.slice(start, index).join('\n');
    }
  }
  return start === -1 ? source : lines.slice(start).join('\n');
};
