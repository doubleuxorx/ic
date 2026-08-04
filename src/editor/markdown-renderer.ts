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

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

import { fileUrl } from '@/workspace/workspace-store';

const md = new MarkdownIt({
  html: false, // no raw HTML by default
  linkify: true,
  breaks: false,
  typographer: false,
});

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
  ALLOWED_ATTR: ['src', 'alt', 'title', 'href', 'class', 'align', 'colspan', 'rowspan'],
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
