// A faster drop-in for makefun-site 1.0.0, written from its README spec.
// run(input) returns exactly the output tree makefun-site's build returns.
//
// Speed plan: no intermediate token trees (Markdown renders in one pass over
// the source's lines; inline rendering scans with native indexOf/regex and
// appends escaped chunks), templates are compiled once per case to plain JS
// functions (new Function) instead of being tree-walked on every page, and
// slugify takes a fast ASCII path (the common case) with a cache.

const hasOwn = Object.hasOwn;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A fresh null-prototype object (template data: no Object.prototype). */
function np() {
  return Object.create(null);
}

// ---------------------------------------------------------------- text
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Manual one-pass escape: ~2x faster than String.replace with a callback
// (measured on titles/urls/code). Long strings first get a native regex test
// so a plain long body returns untouched without a per-char JS scan.
const ESC_TEST = /[&<>"']/;
export function escapeHtml(text) {
  if (text.length >= 64 && !ESC_TEST.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += text.slice(last, i) + rep;
    last = i + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

export function slugify(text, cache) {
  if (cache !== undefined) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    // One native replace: runs of non-alphanumerics become one '-'; a
    // leading/trailing '-' (at most one each, runs already collapsed) is
    // dropped. Truncate first, then drop a '-' left at the cut, exactly
    // like the character loop this replaces.
    out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    out = out.slice(0, 64);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64).replace(/-+$/, '');
  }
  if (out === '') out = 'untitled';
  if (cache !== undefined && cache.size < 8192) cache.set(text, out);
  return out;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !TAG_RE.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Parses front matter of a source whose lines are `lines` (split on \n).
// Returns { data, bodyStart } (body starts at line bodyStart) or { error }.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (BLANK_RE.test(line) || line.charCodeAt(0) === 35) continue; // '#'
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const WS1_RE = /^\s$/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN_RE.test(line); // '`'
  if (c === 35) return headingOf(line) !== null; // '#'
  if (c === 45 || c === 42) return HR_RE.test(line); // '-' '*'
  return false;
}

// One combined pattern for inline rendering, tried in order at each
// position: code span, strong, a literal ** (a strong that cannot close
// skips both stars, exactly like the loop it replaces), emphasis, link,
// backslash escape, lone backslash, and the five escaped characters.
// The emphasis and link closers carry a lookbehind that rejects an odd run
// of backslashes before them (an escaped closer is no closer): the inner
// patterns consume escape pairs and ** pairs greedily, and the lookbehind
// plus the (?!) guards keep a backtrack from ever reopening one as a
// closer. String.replace does the scanning and the string building
// natively, and nested emphasis and link text recurse through the same
// pattern (replace reentrancy on one shared /g pattern is safe: its
// lastIndex resets per call).
const INLINE_RE = /`([^`]+)`|\*\*((?:\\[\s\S]|[^*\\]|\*(?!\*))+)\*\*|\*\*|\*((?:\\[\s\S]|[^*\\]|\*\*)+)(?<!(?:^|[^\\])(?:\\\\)*\\)\*(?!\*)|\[((?:\\[\s\S]|[^\\\]])*)(?<!(?:^|[^\\])(?:\\\\)*\\)\]\(([^)\s]+)\)|\\([\\`*_[\]()#+\-.!>])|\\|[&<>"']/g;

function inline(s, link) {
  return s.replace(INLINE_RE, (m, code, strong, em, ltext, ltarget, esc) => {
    if (code !== undefined) return `<code>${escapeHtml(code)}</code>`;
    if (strong !== undefined) return `<strong>${inline(strong, link)}</strong>`;
    if (m === '**') return '**';
    if (em !== undefined) return `<em>${inline(em, link)}</em>`;
    if (ltext !== undefined) return `<a href="${escapeHtml(link(ltarget))}">${inline(ltext, link)}</a>`;
    if (esc !== undefined) {
      const e = ESCAPES[esc];
      return e === undefined ? esc : e;
    }
    if (m === '\\') return '\\';
    return ESCAPES[m];
  });
}

// Words in one line: the runs of non-whitespace. Tight loop: space/tab
// first; only a non-ASCII char pays for the single-char whitespace test.
// Matches /\S+/g exactly (every other code unit is a word character).
function wordsInLine(s) {
  let n = 0;
  let inWord = false;
  for (let j = 0; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 13) inWord = false;
    else if (c > 127) {
      if (WS1_RE.test(s[j])) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    } else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// Renders lines[lo..hi) to { html, toc, excerpt, words }. link(target) resolves a link.
// The word count rides along: every line is counted exactly once, at the
// place that consumes it (a block's first line at its branch, later lines
// in the branch's own loop), so there is no second pass over the lines.
function renderMarkdown(lines, lo, hi, link, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
      // A line opening on a space or tab is a paragraph line (no block
      // opener allows a leading space/tab); fall through to paragraph.
    } else if (c0 === 96 && line.startsWith('```')) { // '`'
      const fence = FENCE_OPEN_RE.exec(line);
      if (fence !== null) {
        words += wordsInLine(line);
        const lang = fence[1];
        const body = [];
        i++;
        while (i < hi && !FENCE_CLOSE_RE.test(lines[i])) { words += wordsInLine(lines[i]); body.push(lines[i++]); }
        if (i < hi) words += wordsInLine(lines[i]); // the close line: ``` is one word
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) { // '#'
      const heading = headingOf(line);
      if (heading !== null) {
        words += wordsInLine(line);
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' '*'
      if (HR_RE.test(line)) {
        words += wordsInLine(line);
        blocks.push('<hr>\n');
        i++;
        continue;
      }
      const bullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32 ? BULLET_RE.exec(line) : null;
      if (bullet !== null) {
        const items = [];
        while (i < hi) {
          const mm = BULLET_RE.exec(lines[i]);
          if (mm !== null) {
            words += wordsInLine(lines[i]);
            items.push([trimLine(mm[1])]);
            i++;
          } else if (CONTINUED_RE.test(lines[i])) {
            words += wordsInLine(lines[i]);
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        let b = '<ul>\n';
        for (let q = 0; q < items.length; q++) b += `<li>${inline(items[q].join('\n'), link)}</li>\n`;
        blocks.push(`${b}</ul>\n`);
        continue;
      }
    } else if (c0 === 62) { // '>'
      const body = [];
      while (i < hi && lines[i].charCodeAt(0) === 62) { words += wordsInLine(lines[i]); body.push(lines[i++].replace(/^> ?/, '')); }
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(inner.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit: maybe an ordered list
      const ordered = ORDERED_RE.exec(line);
      if (ordered !== null) {
        const items = [];
        while (i < hi) {
          const mm = ORDERED_RE.exec(lines[i]);
          if (mm !== null) {
            words += wordsInLine(lines[i]);
            items.push([trimLine(mm[2])]);
            i++;
          } else if (CONTINUED_RE.test(lines[i])) {
            words += wordsInLine(lines[i]);
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const start = Number(ordered[1]);
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let b = `${open}\n`;
        for (let q = 0; q < items.length; q++) b += `<li>${inline(items[q].join('\n'), link)}</li>\n`;
        blocks.push(`${b}</ol>\n`);
        continue;
      }
    }
    // Paragraph (also reached for space/tab-opening lines and for lines
    // whose first character ruled out every other block).
    words += wordsInLine(line);
    const body = [trimLine(line)];
    i++;
    while (i < hi && !endsParagraph(lines[i])) { words += wordsInLine(lines[i]); body.push(trimLine(lines[i++])); }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '', words };
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- templates
export class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template runtime helpers (passed into compiled functions) ---
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
/** One step down a looked-up value: exact (own property, or undefined). */
function lkS(v, k) {
  if (v === null || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) return hasOwn(v, k) ? v[k] : undefined;
  return v[k];
}

// --- template compiler: node tree -> JS function source ---
// Scopes are the vars objects themselves: a loop scope is created with
// Object.create(parentScope), so a first name resolves by the prototype
// chain (native, no helper call). Every object in the value graph is
// null-prototype, so a direct property read is exact (no Object.prototype
// leaking in, and no own-property check needed).
function lookupExpr(path) {
  let e = `scope[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) e = `lkS(${e},${JSON.stringify(path[k])})`;
  return e;
}

let tmpCounter = 0;
function genNodes(nodes, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(`o.push(${JSON.stringify(n.text)});`);
    } else if (n.kind === 'var') {
      // Inline textOf for the common cases: a string is escaped directly, a
      // number/boolean stringifies without escaping (its digits never need
      // it), and only arrays/objects still go through txt(). The lookup
      // runs once into a temp, not twice.
      const id = tmpCounter++;
      out.push(`{var v${id}=${lookupExpr(n.path)};o.push(v${id}==null?'':typeof v${id}==='string'?esc(v${id}):typeof v${id}==='number'||typeof v${id}==='boolean'?String(v${id}):esc(txt(v${id})));}`);
    } else if (n.kind === 'raw') {
      const id = tmpCounter++;
      out.push(`{var v${id}=${lookupExpr(n.path)};o.push(typeof v${id}==='string'?v${id}:txt(v${id}));}`);
    } else if (n.kind === 'if') {
      // Inline truthy(): the lookup runs once into a temp, and the test is
      // the same logic (not undefined/null/false/""/0, and a non-empty
      // array) without a helper call per if.
      const id = tmpCounter++;
      out.push(`{var v${id}=${lookupExpr(n.path)};if(${n.not ? '!' : ''}(v${id}!==undefined&&v${id}!==null&&v${id}!==false&&v${id}!==''&&v${id}!==0&&(!Array.isArray(v${id})||v${id}.length>0))){`);
      genNodes(n.then, out);
      out.push('}');
      if (n.else !== null) {
        out.push('else{');
        genNodes(n.else, out);
        out.push('}');
      }
      out.push('}');
    } else if (n.kind === 'for') {
      const id = tmpCounter++;
      out.push(`{var xs${id}=${lookupExpr(n.path)};if(Array.isArray(xs${id})){var sc${id}=Object.create(scope);var lp${id}=Object.create(null);lp${id}.index=0;lp${id}.first=true;lp${id}.last=false;lp${id}.length=xs${id}.length;for(var k${id}=0;k${id}<xs${id}.length;k${id}++){sc${id}[${JSON.stringify(n.name)}]=xs${id}[k${id}];lp${id}.index=k${id}+1;lp${id}.first=k${id}===0;lp${id}.last=k${id}===xs${id}.length-1;sc${id}.loop=lp${id};{let scope=sc${id};`);
      genNodes(n.body, out);
      out.push(`}}}}`);
    } else if (n.kind === 'include') {
      out.push(`{var t${tmpCounter}=T.get(${JSON.stringify(n.name)});if(t${tmpCounter}!==undefined&&depth<8)o.push(t${tmpCounter}(scope,depth+1));}`);
      tmpCounter++;
    }
  }
}

function compileTemplate(nodes) {
  tmpCounter = 0;
  const out = ['var o=[];'];
  genNodes(nodes, out);
  out.push('return o.join("");');
  const src = `return function(scope,depth){${out.join('')}}`;
  return new Function('T', 'esc', 'txt', 'truthy', 'lkS', src)(
    compileTemplate.T, escapeHtml, textOf, truthy, lkS,
  );
}

// ---------------------------------------------------------------- build
const RESERVED = ['posts', 'tags', 'page'];

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

export function run(input) {
  // Per-case slug cache: nothing is carried from one case to the next.
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, nodes);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compile parsed templates to functions (shared map, filled in place).
  const compiled = new Map();
  compileTemplate.T = compiled;
  for (const [name, nodes] of templates) compiled.set(name, compileTemplate(nodes));
  compileTemplate.T = null;

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = np();
        tag.name = name;
        tag.slug = slug;
        tag.url = `${base}/tags/${slug}/`;
        tag.posts = [];
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        const found = bySlug.get(slug);
        if (found !== undefined) return found;
        const t = np();
        t.name = name;
        t.slug = slug;
        t.url = '';
        t.posts = [];
        return t;
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => {
    if (s === null) return null;
    const l = np();
    l.title = s.data.title;
    l.url = s.url;
    l.date = s.data.date ?? '';
    l.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    return l;
  };
  const cardOf = (s) => {
    const c = np();
    c.title = s.data.title;
    c.url = s.url;
    c.date = s.data.date ?? '';
    c.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    c.summary = s.data.summary ?? '';
    c.excerpt = s.excerpt;
    c.reading_minutes = Math.max(1, Math.ceil(s.words / 200));
    c.tags = s.tagRefs.map((t) => {
      const o = np();
      o.name = t.name;
      o.slug = t.slug;
      o.url = t.url;
      return o;
    });
    return c;
  };
  // One page object, refilled per page render (a render only ever reads the
  // page of the render in progress, so sharing it is safe).
  const pageObj = np();
  pageObj.title = '';
  pageObj.url = '';
  pageObj.date = '';
  pageObj.date_long = '';
  pageObj.summary = '';
  pageObj.excerpt = '';
  pageObj.reading_minutes = 1;
  pageObj.tags = [];
  pageObj.slug = '';
  pageObj.content = '';
  pageObj.toc = [];
  pageObj.newer = null;
  pageObj.older = null;
  pageObj.is_post = false;
  const fillPage = (s) => {
    pageObj.title = s.data.title;
    pageObj.url = s.url;
    pageObj.date = s.data.date ?? '';
    pageObj.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    pageObj.summary = s.data.summary ?? '';
    pageObj.excerpt = s.excerpt;
    pageObj.reading_minutes = Math.max(1, Math.ceil(s.words / 200));
    pageObj.tags = s.tagRefs.map((t) => {
      const o = np();
      o.name = t.name;
      o.slug = t.slug;
      o.url = t.url;
      return o;
    });
    pageObj.slug = s.slug;
    pageObj.content = s.html;
    pageObj.toc = s.toc.map((h) => {
      const o = np();
      o.level = h.level;
      o.id = h.id;
      o.html = h.html;
      return o;
    });
    pageObj.newer = linkOf(s.newer ?? null);
    pageObj.older = linkOf(s.older ?? null);
    pageObj.is_post = s.post;
    return pageObj;
  };

  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = np();
  site.title = input.site.title;
  site.base_url = base;
  const allTags = tags.map((t) => {
    const o = np();
    o.name = t.name;
    o.slug = t.slug;
    o.url = t.url;
    o.count = t.posts.length;
    return o;
  });
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const tagOf = (t) => {
    const o = np();
    o.name = t.name;
    o.slug = t.slug;
    o.url = t.url;
    o.count = t.posts.length;
    o.posts = t.posts.map((p) => cards.get(p));
    return o;
  };
  const output = {};
  // One root scope, refilled per render. Stale keys are set to null, which
  // templates read exactly like an absent key ("" / false / renders nothing).
  const rootVars = np();
  rootVars.site = site;
  rootVars.tags = allTags;
  rootVars.recent = recent;
  rootVars.page = null;
  rootVars.posts = null;
  rootVars.pager = null;
  rootVars.tag = null;
  const render = (name) => {
    const fn = compiled.get(name);
    return fn === undefined ? null : fn(rootVars, 0);
  };
  for (const s of kept) {
    rootVars.page = fillPage(s);
    rootVars.posts = null;
    rootVars.pager = null;
    rootVars.tag = null;
    output[`${s.outDir}/index.html`] = render(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    rootVars.page = null;
    rootVars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    const pg = np();
    pg.number = k;
    pg.total = pages;
    pg.url = indexUrl(k);
    pg.newer_url = k === 1 ? '' : indexUrl(k - 1);
    pg.older_url = k === pages ? '' : indexUrl(k + 1);
    rootVars.pager = pg;
    rootVars.tag = null;
    const html = render('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    rootVars.page = null;
    rootVars.posts = null;
    rootVars.pager = null;
    rootVars.tag = tagOf(t);
    const html = render('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  rootVars.page = null;
  rootVars.posts = null;
  rootVars.pager = null;
  rootVars.tag = null;
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
