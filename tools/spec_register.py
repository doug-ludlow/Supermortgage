#!/usr/bin/env python3
"""Register new spec sections written in markdown (from spec/TEMPLATE-process.md) into the registries the
audit reads — additively and idempotently. The original 19 sections came from an HTML export
(tools/extract_spec.py); everything written since is markdown-first and goes through here.

  python3 tools/spec_register.py            add what is missing to sections.json / processes.json / timers.json
  python3 tools/spec_register.py --dry-run  report only
  python3 tools/spec_register.py --root DIR use another spec root (tests)

For each spec/sections/NN-slug/N-M-slug.md not yet in processes.json: the process (id, title from the H1,
section, section title from the README H1, path, word count, subsections) and every row of its
"#### Timers and gates" table (code, kind, trigger, anchor, offset, satisfied, breach). Existing rows are never
changed. Then run `npm run spec:manifest` (notices and agents are re-extracted from markdown by
tools/extract_notices.py and tools/extract_agents.py)."""
import re, glob, json, os, sys

args = sys.argv[1:]
root = os.path.join(os.path.dirname(__file__), '..')
spec = os.path.join(root, 'spec')
if '--root' in args: spec = args[args.index('--root') + 1]
dry = '--dry-run' in args
reg = os.path.join(spec, 'registry')

def load(name, default):
    p = os.path.join(reg, name)
    return json.load(open(p)) if os.path.exists(p) else default
def dump(name, obj):
    with open(os.path.join(reg, name), 'w') as f: json.dump(obj, f, indent=2, ensure_ascii=False); f.write('\n')

sections = load('sections.json', [])
processes = load('processes.json', [])
timers = load('timers.json', [])
known_sections = {s['n'] for s in sections}
known_processes = {p['id'] for p in processes}
known_timers = {(t['process'], t['code']) for t in timers}
added = {'sections': [], 'processes': [], 'timers': []}

TIMER_HEADER = re.compile(r'^\|\s*Timer code\s*\|\s*Kind\s*\|\s*Trigger event\s*\|\s*Anchor\s*\|\s*Offset & unit\s*\|\s*Satisfied by\s*\|\s*Breach action\s*\|', re.M)

def timer_rows(text):
    m = re.search(r'#### Timers and gates(.*?)(?=\n#### |\Z)', text, re.S)
    if not m: return []
    block = m.group(1)
    if not TIMER_HEADER.search(block): return []
    out = []
    for line in block.splitlines():
        if not line.startswith('|') or line.startswith('|---') or 'Timer code' in line: continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 7: continue
        code = re.search(r'`([A-Z][A-Z0-9_]+)`', cells[0])
        if not code: continue
        out.append({'code': code.group(1), 'kind': cells[1], 'trigger': cells[2], 'anchor': cells[3], 'offset': cells[4], 'satisfied': cells[5], 'breach': cells[6]})
    return out

for sec_dir in sorted(glob.glob(os.path.join(spec, 'sections', '[0-9][0-9]-*'))):
    dm = re.match(r'(\d+)-', os.path.basename(sec_dir))
    if not dm: continue
    n = int(dm.group(1))
    readme = os.path.join(sec_dir, 'README.md')
    title = None
    if os.path.exists(readme):
        h = re.search(r'^#\s+Section\s+\d+\s+[—-]\s+(.+?)\s*$', open(readme).read(), re.M)
        title = h.group(1) if h else None
    files = sorted(glob.glob(os.path.join(sec_dir, f'{n}-[0-9]*-*.md')))
    ids = []
    for f in files:
        fm = re.match(r'(\d+)-(\d+)-', os.path.basename(f))
        if not fm: continue
        pid = f'{fm.group(1)}.{fm.group(2)}'
        ids.append(pid)
        if pid in known_processes: continue
        text = open(f).read()
        text_nocomment = re.sub(r'<!--.*?-->', '', text, flags=re.S)
        h1 = re.search(r'^#\s+' + re.escape(pid) + r'\s+[—-]\s+(.+?)\s*$', text_nocomment, re.M)
        if not h1: print(f'skip {f}: no "# {pid} — Title" heading'); continue
        if not title:
            st = re.search(r'^\|\s*Section\s*\|\s*\d+\s+[—-]\s+(.+?)\s*\|', text_nocomment, re.M)
            title = st.group(1) if st else f'Section {n}'
        subs = re.findall(r'^####\s+(.+?)\s*$', text_nocomment, re.M)
        meta = {}
        for label, key in (('Automation class', 'auto'), ('SoR / Sub', 'own'), ('Capacity', 'own'), ('Trigger & frequency', 'trigger'), ('Governing source', 'source'), ('Key deadlines', 'deadline')):
            mm = re.search(r'^\|\s*' + re.escape(label) + r'\s*\|\s*(.+?)\s*\|\s*$', text_nocomment, re.M)
            if mm and key not in meta: meta[key] = mm.group(1)
        rows = timer_rows(text_nocomment)
        rec = {'id': pid, 'title': h1.group(1), 'section': n, 'section_title': title, 'words': len(text_nocomment.split()),
               'timers': sorted({r['code'] for r in rows}), 'subsections': subs, 'path': os.path.relpath(f, spec), **meta}
        processes.append(rec); known_processes.add(pid); added['processes'].append(pid)
        for r in rows:
            if (pid, r['code']) in known_timers: continue
            timers.append({'code': r['code'], 'section': n, 'process': pid, **{k: r[k] for k in ('kind', 'trigger', 'anchor', 'offset', 'satisfied', 'breach')}})
            known_timers.add((pid, r['code'])); added['timers'].append(f'{pid}:{r["code"]}')
    if ids and n not in known_sections:
        sections.append({'n': n, 'title': title or f'Section {n}', 'path': os.path.relpath(sec_dir, spec), 'processes': ids})
        known_sections.add(n); added['sections'].append(n)
    elif ids:
        for s in sections:
            if s['n'] == n:
                for pid in ids:
                    if pid not in s['processes']: s['processes'].append(pid)

def pkey(pid): return tuple(int(x) for x in pid.split('.'))
processes.sort(key=lambda p: pkey(p['id']))
sections.sort(key=lambda s: s['n'])
timers.sort(key=lambda t: (pkey(t['process']), t['code']))
summary = f"sections +{len(added['sections'])} {added['sections']}; processes +{len(added['processes'])} {added['processes']}; timers +{len(added['timers'])}"
if dry or not any(added.values()):
    print(('dry run: ' if dry else 'nothing to add: ') + summary); sys.exit(0)
dump('sections.json', sections); dump('processes.json', processes); dump('timers.json', timers)
print('registered: ' + summary + '\nnext: npm run spec:manifest && npm run spec:scaffold && npm run audit')
