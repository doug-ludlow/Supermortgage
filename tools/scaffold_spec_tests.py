#!/usr/bin/env python3
"""One verbatim test file per process: src/domain/<section-dir>/<n>-<m>.spec.test.ts with one node:test per
T-id, named exactly as the spec ("2.1-T3: <verbatim Given/When/Then>"). T-ids that no live test implements
are emitted as `{ todo: true }` placeholders carrying the spec text; tools/audit.py does not count those.
T-ids already implemented elsewhere are listed as a comment so the file indexes the whole process.
Never overwrites an existing file: implement a T-id by replacing its todo line with a real test.

  python3 tools/scaffold_spec_tests.py            write missing files
  python3 tools/scaffold_spec_tests.py --dry-run  list what would be written
"""
import json, os, sys, glob, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
manifest = json.load(open(os.path.join(root, 'spec/registry/manifest.json')))
coverage = json.load(open(os.path.join(root, 'docs/audit/coverage.json')))
cov = {r['process']: r for r in coverage['processes']}
SECTION_DIR = {1: 'boarding', 2: 'cashiering', 3: 'escrow', 4: 'servicing-requests', 5: 'investor', 6: 'custodial', 7: 'notices', 8: 'credit-reporting', 9: 'insurance', 10: 'pmi',
               11: 'early-intervention', 12: 'lossmit', 13: 'foreclosure', 14: 'bankruptcy', 15: 'reo', 16: 'payoff', 17: 'transfers', 18: 'qc-audit', 19: 'data-security'}
dry = '--dry-run' in sys.argv

def tids_in(text):
    """Same grammar as tools/audit.py: `2.1-T3`, `2.1-T1 / T2`, and ranges `3.2-T2..T5`, `3.2-T2–T5`."""
    out = set()
    for m in re.finditer(r'\b(\d{1,2}\.\d{1,2})-T(\d+)((?:\s*/\s*T\d+)*)', text):
        out.add((m.group(1), int(m.group(2))))
        for x in re.findall(r'T(\d+)', m.group(3)): out.add((m.group(1), int(x)))
    for m in re.finditer(r'\b(\d{1,2}\.\d{1,2})-T(\d+)\s*(?:[–-]|\.\.|…)\s*T(\d+)', text):
        for i in range(int(m.group(2)), int(m.group(3)) + 1): out.add((m.group(1), i))
    return out
live_index = {}
for f in sorted(glob.glob(os.path.join(root, 'src/**/*.test.ts'), recursive=True)):
    if f.endswith('.spec.test.ts'): continue
    for line in open(f, encoding='utf-8'):
        if 'todo: true' in line: continue
        for k in tids_in(line): live_index.setdefault(k, os.path.relpath(f, root))
def covered_in(pid, n):
    """Which live (non-scaffold) test file names <pid>-T<n>, or None."""
    return live_index.get((pid, n))

written = 0
for p in manifest:
    pid = p['process']; sec = int(pid.split('.')[0])
    d = SECTION_DIR[sec]
    if sec == 1 and pid != '1.1': d = 'transfers'  # 1.2–1.7 (transfer-in) live with 17.x in src/domain/transfers
    path = os.path.join(root, 'src/domain', d, pid.replace('.', '-') + '.spec.test.ts')
    if os.path.exists(path): continue
    missing = set(cov[pid]['tids']['missing'])
    lines = [f'// {pid} {p["title"]}', f'// spec/{p["path"]}', '// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not',
             '// count it). Implement by replacing the todo line with a real test; never edit the name.', 'import { test } from "node:test";', '']
    for t in p['tids']:
        n = t['n']; name = f'{pid}-T{n}' + (f': {t["text"]}' if t['text'] else '')
        if n in missing: lines.append(f'test({json.dumps(name)}, {{ todo: true }});')
        else: lines.append(f'// {pid}-T{n} — implemented in {covered_in(pid, n)}')
    lines.append('')
    print(('would write ' if dry else 'wrote ') + os.path.relpath(path, root) + f'  ({len(missing)} todo, {len(p["tids"]) - len(missing)} indexed)')
    if not dry:
        os.makedirs(os.path.dirname(path), exist_ok=True); open(path, 'w', encoding='utf-8').write('\n'.join(lines))
    written += 1
print(f'{written} files ' + ('to write' if dry else 'written'))
