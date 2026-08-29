// Minimal XML parser for the SVG subset SVB v0.1 supports.
// Handles: tags, attributes (single/double quotes), self-closing, text nodes,
// comments, CDATA, processing instructions, doctype, and basic entities.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[body] ?? all;
  });
}

// Node: { tag, attrs: {}, children: [], text }
// Text content is aggregated per parent in `text` (trimmed); only
// meaningful for <title>/<desc>.

export function parseXml(src) {
  let i = 0;
  const root = { tag: '#document', attrs: {}, children: [] };
  const stack = [root];

  const fail = (msg) => { throw new Error(`XML parse error at ${i}: ${msg}`); };

  while (i < src.length) {
    const parent = stack[stack.length - 1];
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      appendText(parent, src.slice(i));
      break;
    }
    if (lt > i) appendText(parent, src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) fail('unterminated comment');
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) fail('unterminated CDATA');
      appendText(parent, src.slice(lt + 9, end), true);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      if (end < 0) fail('unterminated declaration');
      i = end + 1;
      continue;
    }

    // Closing tag
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      if (end < 0) fail('unterminated closing tag');
      const tag = src.slice(lt + 2, end).trim();
      if (stack.length < 2 || parent.tag !== tag) fail(`mismatched </${tag}>, expected </${parent.tag}>`);
      stack.pop();
      i = end + 1;
      continue;
    }

    // Opening tag
    const node = { tag: '', attrs: {}, children: [], text: '' };
    i = parseTagStart(src, lt, node, fail);
    parent.children.push(node);
    if (!node.selfClosing) stack.push(node);
  }
  return root;
}

function appendText(node, s, raw = false) {
  const t = raw ? s : decodeEntities(s);
  node.text += (node.text ? ' ' : '') + t.replace(/\s+/g, ' ').trim();
}

// Sticky regexes run against the original string (no repeated substring copies,
// which made adversarial attribute lists quadratic).
const TAG_NAME_RE = /[\w:.-]+/y;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function parseTagStart(src, start, node, fail) {
  let i = start + 1;
  TAG_NAME_RE.lastIndex = i;
  const tagMatch = TAG_NAME_RE.exec(src);
  if (!tagMatch) fail('bad tag name');
  node.tag = tagMatch[0];
  i = TAG_NAME_RE.lastIndex;

  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) fail('unterminated tag');
    const c = src[i];
    if (c === '>') return i + 1;
    if (c === '/' && src[i + 1] === '>') { node.selfClosing = true; return i + 2; }
    ATTR_RE.lastIndex = i;
    const attrMatch = ATTR_RE.exec(src);
    if (!attrMatch) fail(`bad attribute near "${src.slice(i, i + 20)}"`);
    node.attrs[attrMatch[1]] = decodeEntities(attrMatch[2] ?? attrMatch[3] ?? '');
    i = ATTR_RE.lastIndex;
  }
}

// Escape for re-emission as SVG text/markup.

export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}
