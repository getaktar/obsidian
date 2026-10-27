import { isImageFilename, mimeTypeForExtension, pathExtension } from './contentType.ts';
import { normalizeBaseURL } from './publicUrl.ts';

/**
 * Reading and writing the links in a note's text. Kept free of Obsidian so
 * the rules can be tested on their own: what counts as a link, what's left
 * alone (code, front matter), and how a local embed becomes a remote one and
 * back without losing its size or caption.
 */

export interface TextRange {
  start: number;
  end: number;
}

/**
 * Where nothing is touched: the front matter (its links are properties,
 * not embeds), fenced code blocks and inline code.
 */
export function protectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let position = 0;
  const frontMatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (frontMatter) {
    ranges.push({ start: 0, end: frontMatter[0].length });
    position = frontMatter[0].length;
  }
  const lines = text.slice(position).split('\n');
  let fence: { marker: string; start: number } | null = null;
  let offset = position;
  let proseStart = position;
  const inlineIn = (from: number, to: number) => {
    const segment = text.slice(from, to);
    const pattern = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment))) ranges.push({ start: from + match.index, end: from + match.index + match[0].length });
  };
  for (const line of lines) {
    const lineEnd = offset + line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length && line.trim() === marker) {
        ranges.push({ start: fence.start, end: lineEnd });
        fence = null;
        proseStart = lineEnd + 1;
      }
    } else if (marker) {
      inlineIn(proseStart, offset);
      fence = { marker, start: offset };
    }
    offset = lineEnd + 1;
  }
  if (fence) ranges.push({ start: fence.start, end: text.length });
  else inlineIn(proseStart, text.length);
  return ranges.sort((a, b) => a.start - b.start);
}

function isProtected(ranges: TextRange[], start: number, end: number): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

// MARK: Local references

export interface LocalReference extends TextRange {
  embed: boolean;
  style: 'wiki' | 'markdown';
  /** The path as written, decoded for markdown links, without #subpath. */
  linkpath: string;
  /** A size like "300" or "300x200", from `|300` (wiki) or `alt|300` (markdown). */
  size: string | null;
  /** The display text or caption, if any, without the size. */
  caption: string | null;
}

const WIKI_LINK = /(!?)\[\[([^\[\]|#^\n]+)(#[^\[\]|\n]*)?(?:\|([^\[\]\n]*))?\]\]/g;
const MARKDOWN_LINK = /(!?)\[((?:\\.|[^\[\]\\\n])*)\]\(\s*(<[^<>\n]+>|[^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const SIZE = /^\d+(x\d+)?$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Splits "caption|300" (or just "300") into caption and size. */
export function splitSize(text: string): { caption: string | null; size: string | null } {
  const trimmed = text.trim();
  if (SIZE.test(trimmed)) return { caption: null, size: trimmed };
  const bar = trimmed.lastIndexOf('|');
  if (bar !== -1 && SIZE.test(trimmed.slice(bar + 1).trim())) {
    const caption = trimmed.slice(0, bar).trim();
    return { caption: caption || null, size: trimmed.slice(bar + 1).trim() };
  }
  return { caption: trimmed || null, size: null };
}

function decodeLinkpath(raw: string): string {
  const path = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Links and embeds that point at files in the vault: `![[a.png|300]]`,
 * `[[doc.pdf]]`, `![](a%20b.png)`. Notes (no extension or ".md") and
 * anything with a URL scheme are left out.
 */
export function findLocalReferences(text: string, options: { includeProtected?: boolean } = {}): LocalReference[] {
  const guarded = options.includeProtected ? [] : protectedRanges(text);
  const found: LocalReference[] = [];
  for (const match of text.matchAll(WIKI_LINK)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (isProtected(guarded, start, end)) continue;
    const linkpath = match[2].trim();
    if (!isAttachmentPath(linkpath)) continue;
    const alias = match[4] ?? '';
    const { caption, size } = splitSize(alias);
    found.push({ start, end, embed: match[1] === '!', style: 'wiki', linkpath, size, caption });
  }
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (isProtected(guarded, start, end)) continue;
    const raw = match[3];
    const target = raw.startsWith('<') ? raw.slice(1, -1) : raw;
    if (URL_SCHEME.test(target) || target.startsWith('#')) continue;
    const linkpath = decodeLinkpath(raw).replace(/#.*$/, '');
    if (!isAttachmentPath(linkpath)) continue;
    const { caption, size } = splitSize(unescapeMarkdown(match[2]));
    found.push({ start, end, embed: match[1] === '!', style: 'markdown', linkpath, size, caption });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** A path to a file that isn't a note: it has an extension other than .md. */
function isAttachmentPath(path: string): boolean {
  const ext = pathExtension(path).toLowerCase();
  return ext !== '' && ext !== 'md';
}

// MARK: Remote links

/** How links to one destination are recognized: its public base URL. */
export interface LinkMatcher {
  id: string;
  /** Normalized, with exactly one trailing "/". */
  base: string;
}

export function linkMatcher(id: string, publicBaseURL: string): LinkMatcher | null {
  if (!publicBaseURL.trim()) return null;
  return { id, base: normalizeBaseURL(publicBaseURL).replace(/\/+$/, '') + '/' };
}

export interface RemoteLink extends TextRange {
  embed: boolean;
  /** `bare` is a URL on its own, outside any markdown link. */
  style: 'markdown' | 'bare';
  url: string;
  destinationId: string;
  key: string;
  size: string | null;
  caption: string | null;
}

/** The object key a URL points at, if it's under one of the destinations. */
export function matchRemoteURL(url: string, matchers: LinkMatcher[]): { destinationId: string; key: string } | null {
  const clean = url.trim().replace(/^<|>$/g, '');
  for (const matcher of matchers) {
    if (clean.length <= matcher.base.length) continue;
    if (clean.slice(0, matcher.base.length).toLowerCase() !== matcher.base.toLowerCase()) continue;
    const path = clean.slice(matcher.base.length).replace(/[?#].*$/, '');
    if (!path) continue;
    const key = path
      .split('/')
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join('/');
    return { destinationId: matcher.id, key };
  }
  return null;
}

const BARE_URL = /https?:\/\/[^\s<>()\[\]"'`]+/g;

/** Every link in the text to a file in one of the destinations, markdown or bare. */
export function findRemoteLinks(text: string, matchers: LinkMatcher[], options: { includeCode?: boolean } = {}): RemoteLink[] {
  if (matchers.length === 0) return [];
  const guarded = options.includeCode ? [] : protectedRanges(text);
  const found: RemoteLink[] = [];
  const covered: TextRange[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const raw = match[3];
    const url = raw.startsWith('<') ? raw.slice(1, -1) : raw;
    const hit = matchRemoteURL(url, matchers);
    if (!hit) continue;
    covered.push({ start, end });
    if (isProtected(guarded, start, end)) continue;
    const { caption, size } = splitSize(unescapeMarkdown(match[2]));
    found.push({ start, end, embed: match[1] === '!', style: 'markdown', url, ...hit, size, caption });
  }
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index ?? 0;
    // A trailing period or comma ends the sentence, not the URL.
    const url = match[0].replace(/[.,;:!?]+$/, '');
    const end = start + url.length;
    if (covered.some((range) => start >= range.start && start < range.end)) continue;
    if (isProtected(guarded, start, end)) continue;
    const hit = matchRemoteURL(url, matchers);
    if (!hit) continue;
    found.push({ start, end, embed: false, style: 'bare', url, ...hit, size: null, caption: null });
  }
  return found.sort((a, b) => a.start - b.start);
}

// MARK: Writing links

/** Files Obsidian shows inline from a URL: images, and with the plugin, audio and video. */
export function isEmbeddable(filename: string): boolean {
  if (isImageFilename(filename)) return true;
  const mime = mimeTypeForExtension(pathExtension(filename)) ?? '';
  return (mime.startsWith('video/') && pathExtension(filename).toLowerCase() !== 'ts') || mime.startsWith('audio/');
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\[\]()])/g, '$1');
}

/** A URL as a markdown link target: wrapped in <> when it holds spaces or parentheses. */
export function linkTarget(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/>/g, '%3E')}>` : url;
}

/**
 * The markdown for a file at `url`: an embed for what Obsidian can show
 * inline, a link for everything else. `caption` and `size` carry over
 * from the link it replaces (`![caption|300](url)`).
 */
export function remoteMarkup(url: string, filename: string, options: { embed?: boolean; caption?: string | null; size?: string | null } = {}): string {
  const embed = (options.embed ?? true) && isEmbeddable(filename);
  if (!embed) return `[${escapeMarkdown(options.caption || filename)}](${linkTarget(url)})`;
  const caption = escapeMarkdown(options.caption ?? '');
  const alt = options.size ? (caption ? `${caption}|${options.size}` : options.size) : caption;
  return `![${alt}](${linkTarget(url)})`;
}

// MARK: Upload placeholders

/**
 * What's put in the note while a file uploads: a plain link (not an embed,
 * so nothing renders broken) with an ID only this upload has. It's found
 * again by that ID, wherever the text around it moved in the meantime.
 */
export function placeholderMarkup(id: string, filename: string, label: string): string {
  return `[${escapeMarkdown(`${label} ${filename}`)}](aktar-upload:${id})`;
}

export function findPlaceholder(text: string, id: string): TextRange | null {
  const needle = `](aktar-upload:${id})`;
  const close = text.indexOf(needle);
  if (close === -1) return null;
  // Back to the opening "[" of this link, skipping escaped brackets.
  let start = close - 1;
  while (start >= 0) {
    if (text[start] === '[' && text[start - 1] !== '\\') break;
    if (text[start] === '\n') return null;
    start--;
  }
  return start < 0 ? null : { start, end: close + needle.length };
}

/** Upload IDs of every placeholder in the text. */
export function placeholderIds(text: string): string[] {
  return [...text.matchAll(/\]\(aktar-upload:([A-Za-z0-9-]+)\)/g)].map((match) => match[1]);
}

/** Applies replacements (non-overlapping ranges) from the end, so earlier offsets stay valid. */
export function applyReplacements(text: string, replacements: (TextRange & { text: string })[]): string {
  let result = text;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}
