/**
 * Extension -> MIME type table, the same as the other Aktar apps'. Covers
 * what people actually upload; anything else is application/octet-stream.
 */
const MIME_TYPES: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  ico: 'image/x-icon',
  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  rtf: 'text/rtf',
  epub: 'application/epub+zip',
  // Text & code
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  log: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  xht: 'application/xhtml+xml',
  css: 'text/css',
  xml: 'application/xml',
  json: 'application/json',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'video/mp2t',
  tsx: 'text/plain',
  jsx: 'text/plain',
  swift: 'text/x-swift',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/x-java-source',
  kt: 'text/plain',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++src',
  sh: 'application/x-sh',
  sql: 'application/sql',
  // Archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  dmg: 'application/x-apple-diskimage',
  apk: 'application/vnd.android.package-archive',
  ipa: 'application/octet-stream',
  // Video
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  // Audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  aiff: 'audio/aiff',
  // Fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  // Other
  wasm: 'application/wasm',
  ics: 'text/calendar',
  vcf: 'text/vcard',
};

/**
 * Files a browser would run as a page (HTML, SVG, XML, JavaScript): served
 * inline from the bucket's domain, a shared link to one could run scripts
 * there. They're uploaded with `Content-Disposition: attachment` so opening
 * the link downloads them; the Content-Type stays, so `<img src="x.svg">`
 * still renders.
 */
const ACTIVE_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'xht', 'svg', 'svgz', 'xml', 'js', 'mjs']);
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
]);

export function isActiveContent(keyOrFilename: string, contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return ACTIVE_EXTENSIONS.has(pathExtension(keyOrFilename).toLowerCase()) || ACTIVE_CONTENT_TYPES.has(type);
}

/** The extra upload header for `isActiveContent` files, none for anything else. */
export function attachmentHeaders(keyOrFilename: string, contentType: string): Record<string, string> {
  return isActiveContent(keyOrFilename, contentType) ? { 'Content-Disposition': 'attachment' } : {};
}

const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar']);

export function pathExtension(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1);
}

export function deletingPathExtension(filename: string): string {
  const ext = pathExtension(filename);
  return ext ? filename.slice(0, -(ext.length + 1)) : filename;
}

export function mimeTypeForExtension(ext: string): string | undefined {
  return MIME_TYPES[ext.toLowerCase()];
}

/** A conventional extension for a MIME type, for shared files that arrive without a name. */
export function extensionForMimeType(mimeType: string | null | undefined): string | undefined {
  if (!mimeType) return undefined;
  const preferred: Record<string, string> = { 'image/jpeg': 'jpg', 'text/plain': 'txt', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3' };
  if (preferred[mimeType]) return preferred[mimeType];
  return Object.keys(MIME_TYPES).find((ext) => MIME_TYPES[ext] === mimeType);
}

/** Extension first (like the Mac app), then the picker's own guess. */
export function resolveContentType(filename: string, fallback?: string | null): string {
  return mimeTypeForExtension(pathExtension(filename)) ?? (fallback || 'application/octet-stream');
}

export function isImageFilename(filename: string): boolean {
  return mimeTypeForExtension(pathExtension(filename))?.startsWith('image/') ?? false;
}

export type FileKind = 'image' | 'pdf' | 'archive' | 'movie' | 'audio' | 'text' | 'generic';

export function fileKind(filename: string): FileKind {
  const ext = pathExtension(filename).toLowerCase();
  if (!ext) return 'generic';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  const mime = mimeTypeForExtension(ext);
  if (!mime) return 'generic';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/') && ext !== 'ts') return 'movie';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || ['json', 'xml', 'yml', 'yaml', 'sh', 'sql'].includes(ext)) return 'text';
  return 'generic';
}
