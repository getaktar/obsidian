import { escapeHTML } from '../core/html.ts';

/**
 * The page a published note goes into. A Content Security Policy forbids
 * every script and plugin, so whatever HTML a note holds, the page can only
 * be read: it's served from the same domain as the rest of the bucket.
 * It asks search engines not to index it; the link is how it's found.
 */
export function pageHTML(page: { title: string; body: string; date: Date; lang: string }): string {
  const title = escapeHTML(page.title);
  const date = page.date.toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="${escapeHTML(page.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; media-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
:root { --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d8dee4; --code: #f6f8fa; --accent: #125efe; }
@media (prefers-color-scheme: dark) { :root { --bg: #16181d; --fg: #e6e8eb; --muted: #9aa1ab; --line: #30343c; --code: #1f2229; --accent: #6d9bff; } }
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); }
body { margin: 0 auto; max-width: 46rem; padding: 3rem 1rem 4rem; font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; overflow-wrap: break-word; }
header { margin-bottom: 2rem; }
header h1 { font-size: 2.1rem; line-height: 1.2; margin: 0 0 .4rem; }
header time, footer { color: var(--muted); font-size: .85rem; }
h1, h2, h3, h4 { line-height: 1.3; margin: 2rem 0 .75rem; }
a { color: var(--accent); }
img, video { max-width: 100%; height: auto; border-radius: 6px; }
audio { width: 100%; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; background: var(--code); border-radius: 6px; }
code { padding: .1em .35em; }
pre { padding: 1rem; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote, .callout { margin: 1rem 0; padding: .5rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: .4rem .6rem; text-align: left; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
ul.contains-task-list { list-style: none; padding-left: 1.2rem; }
mark { background: #fff3a3; color: #1f2328; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<header><h1>${title}</h1><time datetime="${date}">${date}</time></header>
<main>
${page.body}
</main>
<footer>Published with Aktar</footer>
</body>
</html>
`;
}
