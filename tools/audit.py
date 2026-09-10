#!/usr/bin/env python3
"""Coverage audit of the build against spec/: T-numbered tests, data-model tables, worked-example figures,
timers, notices, agents, adapters. Writes docs/audit/coverage.json and prints a summary."""
import re, glob, json, os, collections, subprocess
root = os.path.join(os.path.dirname(__file__), '..')
os.makedirs(os.path.join(root, 'docs/audit'), exist_ok=True)
procs = json.load(open(os.path.join(root, 'spec/registry/processes.json')))
SECTION_DIR = {1: ['boarding', 'transfers'], 2: ['cashiering'], 3: ['escrow'], 4: ['servicing-requests'], 5: ['investor'], 6: ['custodial'], 7: ['notices'], 8: ['credit-reporting'],
               9: ['insurance'], 10: ['pmi'], 11: ['early-intervention'], 12: ['lossmit'], 13: ['foreclosure'], 14: ['bankruptcy'], 15: ['reo'], 16: ['payoff'], 17: ['transfers'], 18: ['qc-audit'], 19: ['data-security']}
def spec_text(p):
    return open(os.path.join(root, 'spec', p['path'])).read()
tests_all = ''
for f in glob.glob(os.path.join(root, 'src/**/*.test.ts'), recursive=True):
    tests_all += open(f).read() + '\n'
section_tests = {}
for sec, dirs in SECTION_DIR.items():
    t = ''
    for d in dirs:
        for f in glob.glob(os.path.join(root, f'src/domain/{d}/*.test.ts')): t += open(f).read() + '\n'
    section_tests[sec] = t
# ---- T-ids
def tids_in(text):
    out = set()
    for m in re.finditer(r'\b(\d{1,2}\.\d{1,2})-T(\d+)((?:\s*/\s*T\d+)*)', text):
        out.add((m.group(1), int(m.group(2))))
        for x in re.findall(r'T(\d+)', m.group(3)): out.add((m.group(1), int(x)))
    # ranges like 2.1-T1 … T6 or "T1–T6"
    for m in re.finditer(r'\b(\d{1,2}\.\d{1,2})-T(\d+)\s*(?:[–-]|\.\.|…)\s*T(\d+)', text):
        for i in range(int(m.group(2)), int(m.group(3)) + 1): out.add((m.group(1), i))
    return out
spec_tids = collections.defaultdict(set); impl_tids = tids_in(tests_all)
for p in procs:
    for pid, n in tids_in(spec_text(p)):
        if pid == p['id']: spec_tids[pid].add(n)
tid_rows = []
for p in procs:
    s = spec_tids[p['id']]; i = {n for (pid, n) in impl_tids if pid == p['id']} & s
    tid_rows.append({'process': p['id'], 'spec': len(s), 'implemented': len(i), 'missing': sorted(s - i)})
# ---- tables
created = set(re.findall(r'CREATE (?:TABLE|VIEW)\s+(?:IF NOT EXISTS\s+)?(?:restricted_fl\.)?(\w+)', '\n'.join(open(f).read() for f in glob.glob(os.path.join(root, 'db/migrations/*.sql')))))
table_rows = []
for p in procs:
    t = spec_text(p)
    m = re.search(r'#### Data model(.*?)(?=\n#### )', t, re.S)
    names = set()
    if m:
        for n in re.findall(r'(?:^|\n)\s*[-*]\s*\*{0,2}`([a-z][a-z0-9_]{3,})`', m.group(1)):
            if not n.endswith(('_id', '_at', '_on', '_cents', '_pct', '_date', '_flag')) and '.' not in n: names.add(n)
        for n in re.findall(r'`([a-z][a-z0-9_]{3,})`\s*\((?:baseline|new|extended|append-only)', m.group(1)): names.add(n)
    table_rows.append({'process': p['id'], 'spec': sorted(names), 'missing': sorted(n for n in names if n not in created and n + 's' not in created)})
# ---- worked-example money figures
def cents(s): return int(round(float(s.replace('$', '').replace(',', '')) * 100))
fig_rows = []
for p in procs:
    t = spec_text(p)
    m = re.search(r'#### Business rules(.*?)(?=\n#### )', t, re.S)
    body = m.group(1) if m else ''
    figs = sorted({f for f in re.findall(r'\$[\d,]{1,12}\.\d{2}', body)})
    sec = int(p['id'].split('.')[0]); tt = section_tests.get(sec, '')
    flat = tt.replace('_', '')
    strict = [f for f in figs if (f'{cents(f)}n' in flat or f in tt)]
    loose = [f for f in figs if (f in strict or re.search(r'(?<![\d.])0*' + str(cents(f)) + r'(?![\d])', flat) or f.replace('$', '') in tt)]
    fig_rows.append({'process': p['id'], 'figures': len(figs), 'reproduced': len(strict), 'reproduced_loose': len(loose), 'missing': [f for f in figs if f not in loose][:12]})
# ---- timers / notices / agents / adapters
lint = subprocess.run(['node', '--experimental-strip-types', 'tools/lint-registry.ts'], cwd=root, capture_output=True, text=True).stdout
notices = json.load(open(os.path.join(root, 'spec/registry/notices.json')))
authored = re.findall(r'V\("([A-Z0-9_]+)"', open(os.path.join(root, 'src/notices/catalog.ts')).read())
agents = json.load(open(os.path.join(root, 'spec/registry/agents.json')))
commands = re.findall(r'name: "([a-z\-]+\.[A-Za-z]+)"', open(os.path.join(root, 'src/app/catalog.ts')).read())
adapter_names = collections.Counter(re.findall(r'`((?:fnma-[a-z0-9\-]+|mers|custodian|print-mail|e-delivery|e-oscar|lockbox|custodial-bank|nacha|tax-service|flood|insurance-tracking/lpi|mi/\*|pacer/bk-monitor|dmdc|erecording|telephony/voice|email-in|fnma-auth|index-feed|skip-trace|usps[a-z/ ]*|metro2|e-vault|evault))`', '\n'.join(spec_text(p) for p in procs)))
ports = re.findall(r'export interface (\w+Port)\b', '\n'.join(open(f).read() for f in glob.glob(os.path.join(root, 'src/infra/integrations/*.ts'))))
out = {'tids': tid_rows, 'tables': table_rows, 'figures': fig_rows, 'lint': lint, 'notices': {'catalog': len(notices), 'authored': authored}, 'agents': {'count': len(agents['agents']), 'tools': sum(len(a['tools']) for a in agents['agents']), 'commands_on_bus': commands}, 'adapters': {'named': adapter_names.most_common(), 'ports': ports}}
json.dump(out, open(os.path.join(root, 'docs/audit/coverage.json'), 'w'), indent=1)
ts = sum(r['spec'] for r in tid_rows); ti = sum(r['implemented'] for r in tid_rows)
print(f"T-ids: {ti}/{ts} implemented ({100*ti/ts:.0f}%)")
by = collections.defaultdict(lambda: [0, 0])
for r in tid_rows: by[r['process'].split('.')[0]][0] += r['spec']; by[r['process'].split('.')[0]][1] += r['implemented']
print('  by section: ' + '  '.join(f"§{k}:{v[1]}/{v[0]}" for k, v in sorted(by.items(), key=lambda x: int(x[0]))))
tn = sum(len(r['spec']) for r in table_rows); tm = sum(len(r['missing']) for r in table_rows)
print(f"tables named in Data model subsections: {tn}; not created: {tm}")
fn = sum(r['figures'] for r in fig_rows); fr = sum(r['reproduced'] for r in fig_rows)
fl = sum(r['reproduced_loose'] for r in fig_rows)
print(f"worked-example money figures: {fr}/{fn} reproduced verbatim as cents/dollars ({100*fr/max(fn,1):.0f}%); {fl}/{fn} counting zero-padded or bare-digit matches ({100*fl/max(fn,1):.0f}%)")
print(f"notices: {len(authored)}/{len(notices)} with an authored template version; agents {len(agents['agents'])}, spec tools {sum(len(a['tools']) for a in agents['agents'])}, commands on bus {len(commands)}")
print(f"adapters named in spec: {len(adapter_names)}; ports built: {len(ports)}")
print([l for l in lint.splitlines() if 'after section overrides' in l or 'satisfied pattern' in l or 'anchor field' in l])
