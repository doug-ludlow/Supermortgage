#!/usr/bin/env python3
"""Import the Origination build specification (the claude.ai artifact "Supermortgage Origination Spec", rendered
markdown → HTML) into the spec tree as markdown-first sections 20–31, in the exact textual forms the audit counts.

  python3 tools/import_origination.py ARTIFACT.html [--out spec] [--dry-run]

Mapping (the platform keeps one id grammar, N.M, across origination and servicing):
  Section O1 → 20 … O12 → 31 (N + 19); process O2.3 → 21.3; test O2.3-T4 → 21.3-T4; question O7.4-Q1 → 26.4-Q1.
  Timer codes, notice codes, event names, table names are copied verbatim (an identifier such as SM_O21_… is not a
  section reference and is not rewritten).
Writes:
  spec/sections/NN-slug/README.md              section overview, process table, section-level test plan/questions/sources
  spec/sections/NN-slug/NN-M-slug.md           one file per process, template headings verbatim, attribute table first
  spec/origination/*.md                        master index, architecture baseline addendum, process inventory, research,
                                               verification report, timer registry (reference material; not counted)
Then: npm run spec:register && npm run spec:manifest && npm run spec:scaffold && npm run audit
"""
import re, os, sys, html
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_spec import slug  # noqa: E402

SECTION_OFFSET = 19
REF_DOCS = {'index': '00-master-index', 'baseline': '01-architecture-baseline-addendum', 'inventory': '02-process-inventory',
            'template': '03-spec-template', 'r-fed': '04-research-federal-regulatory-status', 'r-fnma': '05-research-fannie-mae-policy-status',
            'r-int': '06-research-integration-landscape', 'verification': '07-verification-report', 'timers': '08-timer-registry'}

# ---------------------------------------------------------------- HTML → markdown
class MD(HTMLParser):
    """Rendered-markdown HTML (h1–h4, p, ul/ol/li, table, code, strong, em, a, hr, pre, blockquote) back to markdown."""
    BLOCK = {'h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'hr', 'pre', 'blockquote', 'div', 'article'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []          # finished markdown blocks
        self.buf = []          # inline text of the current block
        self.stack = []        # open tags
        self.list_stack = []   # ('ul'|'ol', counter)
        self.table = None      # {'rows': [[cells]], 'head': n}
        self.cell = None
        self.in_pre = False

    def text(self): return ''.join(self.buf)
    def flush(self):
        s = self.text(); self.buf = []
        return s

    def handle_starttag(self, tag, attrs):
        self.stack.append(tag)
        if tag in ('h1', 'h2', 'h3', 'h4', 'p', 'blockquote'):
            self.buf = []
        elif tag in ('ul', 'ol'):
            self.list_stack.append([tag, 0])
        elif tag == 'li':
            self.buf = []
        elif tag == 'table':
            self.table = {'rows': [], 'head': 0}
        elif tag == 'tr':
            self.table['rows'].append([])
        elif tag in ('td', 'th'):
            self.buf = []; self.cell = tag
        elif tag == 'hr':
            self.out.append('---')
        elif tag == 'pre':
            self.in_pre = True; self.buf = []
        elif tag == 'code':
            if not self.in_pre: self.buf.append('\x00code\x00')
        elif tag == 'strong':
            self.buf.append('**')
        elif tag == 'em':
            self.buf.append('*')

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag: self.stack.pop()
        if tag in ('h1', 'h2', 'h3', 'h4'):
            self.out.append('#' * int(tag[1]) + ' ' + self.flush().strip())
        elif tag == 'p':
            s = self.flush().strip()
            if s: self.out.append(s)
        elif tag == 'blockquote':
            s = self.flush().strip()
            if s: self.out.append('\n'.join('> ' + l for l in s.splitlines()))
        elif tag in ('ul', 'ol'):
            self.list_stack.pop()
            if not self.list_stack: self.out.append('')
        elif tag == 'li':
            kind, n = self.list_stack[-1] if self.list_stack else ('ul', 0)
            if self.list_stack: self.list_stack[-1][1] += 1
            marker = '- ' if kind == 'ul' else f'{self.list_stack[-1][1]}. '
            self.out.append('  ' * (len(self.list_stack) - 1) + marker + self.flush().strip())
        elif tag in ('td', 'th'):
            s = self.flush().strip().replace('\n', ' ')
            s = re.sub(r'(?<!\\)\|', r'\\|', s)
            self.table['rows'][-1].append(s)
            if tag == 'th': self.table['head'] = len(self.table['rows'])
            self.cell = None
        elif tag == 'table':
            rows = [r for r in self.table['rows'] if r]
            if rows:
                width = max(len(r) for r in rows)
                lines = []
                head = rows[0] if self.table['head'] else ['' for _ in range(width)]
                body = rows[1:] if self.table['head'] else rows
                lines.append('| ' + ' | '.join(head + [''] * (width - len(head))) + ' |')
                lines.append('|' + '---|' * width)
                for r in body: lines.append('| ' + ' | '.join(r + [''] * (width - len(r))) + ' |')
                self.out.append('\n'.join(lines))
            self.table = None
        elif tag == 'pre':
            self.in_pre = False
            self.out.append('```\n' + self.flush().rstrip('\n') + '\n```')
        elif tag == 'code':
            if not self.in_pre: self.buf.append('\x00/code\x00')
        elif tag == 'strong':
            self.buf.append('**')
        elif tag == 'em':
            self.buf.append('*')

    def handle_data(self, data):
        if self.in_pre: self.buf.append(data); return
        if not self.stack or self.stack[-1] in ('article', 'div', 'ul', 'ol', 'table', 'thead', 'tbody', 'tr'):
            if data.strip() == '': return
        self.buf.append(data)

    def markdown(self):
        md = '\n\n'.join(b for b in self.out if b is not None)
        md = re.sub(r'\n{3,}', '\n\n', md)
        # code spans: pick a fence that does not occur in the content
        def code(m):
            body = m.group(1)
            fence = '`' if '`' not in body else '``'
            pad = ' ' if body.startswith('`') or body.endswith('`') else ''
            return f'{fence}{pad}{body}{pad}{fence}'
        md = re.sub(r'\x00code\x00(.*?)\x00/code\x00', code, md, flags=re.S)
        # list items are single blocks separated by blank lines above; tighten them
        md = re.sub(r'\n\n(?=(?:  )*(?:- |\d+\. ))', '\n', md)
        md = re.sub(r'((?:^|\n)(?:  )*(?:- |\d+\. )[^\n]*)\n\n(?=\n)', r'\1\n', md)
        return md.strip() + '\n'

def to_md(fragment):
    p = MD(); p.feed(fragment); p.close(); return p.markdown()

# ---------------------------------------------------------------- id rewriting
def renumber(text):
    """O2.3 → 21.3 (with -T/-Q suffixes intact); bare O2 / Section O2 / O3–O6 → 21 / Section 21 / 22–25.
    Identifiers (timer codes, `SM_O21_…`) are untouched: an underscore is a word character, so no \\b precedes the O."""
    n = lambda m: str(int(m.group(1)) + SECTION_OFFSET)
    text = re.sub(r'\bO(1[0-2]|[1-9])\.(\d{1,2}|x)\b', lambda m: f'{n(m)}.{m.group(2)}', text)
    text = re.sub(r'\bSection O(1[0-2]|[1-9])\b', lambda m: f'Section {n(m)}', text)
    text = re.sub(r'\bO(1[0-2]|[1-9])/_', lambda m: f'{n(m)}/_', text)
    text = re.sub(r'\bO(1[0-2]|[1-9])(?![\d.\-A-Za-z])', lambda m: f'§{n(m)}', text)
    return text

# ---------------------------------------------------------------- splitting a section article
H2 = re.compile(r'^## (.+)$', re.M)
PROC_H2 = re.compile(r'^## (\d{1,2})\.(\d{1,2}) — (.+)$', re.M)

def split_blocks(md):
    """[(h2 title | None, body)] in document order; the first entry (None) is anything before the first H2."""
    parts = []; last = 0; title = None
    for m in H2.finditer(md):
        parts.append((title, md[last:m.start()].strip())); title = m.group(1).strip(); last = m.end()
    parts.append((title, md[last:].strip()))
    return parts

def attribute_table(section_n, section_title, body):
    """Attribute table from the Blueprint row table + the timers table (spec_register reads these labels)."""
    def cell(label):
        m = re.search(r'^\|\s*' + re.escape(label) + r'\s*\|\s*(.+?)\s*\|\s*$', body, re.M)
        return m.group(1) if m else None
    auto = cell('Automation class (blueprint)') or ''
    am = re.search(r'\(([abc])\)', auto)
    rows = [('Section', f'{section_n} — {section_title}'),
            ('Automation class', (am.group(1) + ' — ' + auto if am else auto) or '—'),
            ('Capacity', cell('LoR / SM') or cell('SoR / Sub') or '—'),
            ('Trigger & frequency', cell('Trigger & frequency') or '—'),
            ('Governing source', cell('Governing source (blueprint)') or cell('Governing source') or '—'),
            ('Key deadlines', cell('Key deadlines (blueprint)') or cell('Key deadlines') or '—')]
    tm = re.search(r'#### Timers and gates(.*?)(?=\n#### |\Z)', body, re.S)
    codes = []
    if tm:
        for line in tm.group(1).splitlines():
            if line.startswith('|') and 'Timer code' not in line and not line.startswith('|---'):
                c = re.match(r'\|\s*`([A-Z][A-Z0-9_]+)`', line)
                if c and c.group(1) not in codes: codes.append(c.group(1))
    rows.append(('Timers', ', '.join(f'`{c}`' for c in codes) or '—'))
    return '| Attribute | Value |\n|---|---|\n' + '\n'.join(f'| {k} | {v} |' for k, v in rows) + '\n'

def demote(md):
    """Inside a section article the process is H2 and its parts H3/H4; the per-process file uses H1/H3/H4 like the
    servicing files (H3 'Blueprint row' … H4 'Inputs and triggers'), so only the H2 → H1 promotion is needed."""
    return md

def main():
    args = sys.argv[1:]
    if not args or args[0].startswith('--'): print(__doc__); sys.exit(2)
    src = args[0]; out = args[args.index('--out') + 1] if '--out' in args else os.path.join(os.path.dirname(__file__), '..', 'spec')
    dry = '--dry-run' in args
    doc = open(src, encoding='utf-8').read()
    articles = re.findall(r'<article class="doc" id="doc-([^"]+)"[^>]*>(.*?)</article>', doc, re.S)
    written = []
    def write(path, text):
        written.append(path)
        if dry: return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, 'w', encoding='utf-8').write(text)

    for doc_id, body in articles:
        md = renumber(to_md(body))
        if doc_id in REF_DOCS:
            write(os.path.join(out, 'origination', REF_DOCS[doc_id] + '.md'), md); continue
        sm = re.match(r'sec-O(\d+)', doc_id)
        if not sm: print('unknown article', doc_id); continue
        n = int(sm.group(1)) + SECTION_OFFSET
        h1 = re.search(r'^# Section (\d+) — (.+)$', md, re.M)
        assert h1 and int(h1.group(1)) == n, (doc_id, h1.group(0) if h1 else None)
        title = h1.group(2).strip()
        sec_dir = os.path.join(out, 'sections', f'{n:02d}-{slug(title)}')
        blocks = split_blocks(md[h1.end():])
        overview, procs, closing = [], [], []
        for t, b in blocks:
            if t is None: continue
            pm = PROC_H2.match('## ' + t)
            if pm and int(pm.group(1)) == n: procs.append((f'{pm.group(1)}.{pm.group(2)}', pm.group(3).strip(), b))
            elif t.lower().startswith('section overview'): overview.append(b)
            else: closing.append(f'### {t}\n\n{b}')
        ids = []
        for pid, ptitle, pbody in procs:
            ids.append((pid, ptitle, pbody))
            fname = f'{pid.replace(".", "-")}-{slug(ptitle)}.md'
            text = f'# {pid} — {ptitle}\n\n' + attribute_table(n, title, pbody) + '\n' + pbody.rstrip() + '\n'
            write(os.path.join(sec_dir, fname), text)
        readme = [f'# Section {n} — {title}', '', f'<!-- imported from the Origination build specification v1.0 (2026-09-11), section O{n - SECTION_OFFSET}; '
                  f'process O{n - SECTION_OFFSET}.M is {n}.M here. tools/import_origination.py -->', '', '## Overview', '', '\n\n'.join(overview).strip(), '',
                  '## Processes', '', '| Process | Title | Automation class |', '|---|---|---|']
        for pid, ptitle, pbody in ids:
            am = re.search(r'^\| Automation class \| ([abc])', attribute_table(n, title, pbody), re.M)
            readme.append(f'| {pid} | {ptitle} | {am.group(1) if am else "—"} |')
        readme += ['', '## Closing', '', '\n\n'.join(closing).strip(), '']
        write(os.path.join(sec_dir, 'README.md'), '\n'.join(readme))
        print(f'section {n:02d} ({doc_id}): {len(ids)} processes → {os.path.relpath(sec_dir, out)}')
    print(f'{"would write" if dry else "wrote"} {len(written)} files')
    leftovers = []
    for p in written:
        if dry or not p.endswith('.md'): continue
        for m in re.finditer(r'\bO(?:1[0-2]|[1-9])(?:\.\d+)?\b', open(p, encoding='utf-8').read()):
            leftovers.append((os.path.relpath(p, out), m.group(0)))
    if leftovers: print('unrewritten O-references:', len(leftovers), leftovers[:12])

if __name__ == '__main__': main()
