#!/usr/bin/env python3
"""Coverage audit of the build against spec/, in the spec's own units, read from spec/registry/manifest.json
(tools/spec_manifest.py). One row per process; a process is "done" only when every unit is built.

  T-ids     acceptance tests: a T-id is implemented when a non-todo node:test names it ("2.1-T3: ...").
  tables    Data-model tables that a migration creates.
  timers    unique timer codes the engine can arm AND satisfy (tools/lint-registry.ts --json).
  notices   NTC_/INS_ codes with an authored template version (src/notices/**, V("CODE", …)).
  tools     agent tools registered on the bus for the process (src/app/tools/*, spec tool string verbatim).
  figures   worked-example money figures from "Business rules" that a test of the section reproduces.

  python3 tools/audit.py              write docs/audit/coverage.json + COVERAGE.md, print the summary
  python3 tools/audit.py --check      exit 1 if any total fell below docs/audit/baseline.json or a process
                                      listed there as done is below 100%  (npm test runs this)
  python3 tools/audit.py --baseline   rewrite baseline.json to the current totals (keeps its done list)
  python3 tools/audit.py --strict     print the brief and the per-process gaps only; writes nothing.
  python3 tools/audit.py --lenient    the pre-closure (looser) units: a T-id counts on any live mention of its id; a timer when
                                      armable and satisfiable. The default is strict: a T-id counts only when a non-todo
                                      node:test is titled exactly "<pid>-T<n>: <spec text>"; a timer only when its satisfied
                                      and trigger events are also emitted somewhere (tools/lint-emission.ts).
  python3 tools/audit.py --brief      one line
  python3 tools/audit.py --hook EVENT emit Claude Code hook JSON (SessionStart | UserPromptSubmit | Stop)
"""
import re, glob, json, os, sys, collections, subprocess
root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
AUDIT = os.path.join(root, 'docs/audit')
os.makedirs(AUDIT, exist_ok=True)
manifest = json.load(open(os.path.join(root, 'spec/registry/manifest.json')))
UNITS = ('tids', 'tables', 'timers', 'notices', 'tools', 'figures')
SECTION_DIR = {1: ['boarding', 'transfers'], 2: ['cashiering'], 3: ['escrow'], 4: ['servicing-requests'], 5: ['investor'], 6: ['custodial'], 7: ['notices'], 8: ['credit-reporting'],
               9: ['insurance'], 10: ['pmi'], 11: ['early-intervention'], 12: ['lossmit'], 13: ['foreclosure'], 14: ['bankruptcy'], 15: ['reo'], 16: ['payoff'], 17: ['transfers'], 18: ['qc-audit'], 19: ['data-security'],
               20: ['leads-pricing'], 21: ['application'], 22: ['verification'], 23: ['underwriting'], 24: ['property'], 25: ['compliance-disclosures'], 26: ['closing'], 27: ['warehouse'], 28: ['qc-hmda'], 29: ['secondary'], 30: ['orig-boarding'], 31: ['governance']}

def read(p): return open(p, encoding='utf-8').read()
def live_lines(text):
    """Drop scaffold placeholders: a `todo: true` test or `test.todo(` names a T-id without implementing it."""
    return '\n'.join(l for l in text.splitlines() if 'todo: true' not in l and 'test.todo(' not in l and 'it.todo(' not in l)
test_files = sorted(glob.glob(os.path.join(root, 'src/**/*.test.ts'), recursive=True))
tests_all = '\n'.join(read(f) for f in test_files)
tests_live = live_lines(tests_all)
section_tests = {sec: live_lines('\n'.join(read(f) for d in dirs for f in glob.glob(os.path.join(root, f'src/domain/{d}/*.test.ts')))) for sec, dirs in SECTION_DIR.items()}

def tids_in(text):
    out = set()
    for m in re.finditer(r'\b(\d{1,2}\.\d{1,2})-T(\d+)((?:\s*/\s*T\d+)*)', text):
        out.add((m.group(1), int(m.group(2))))
        for x in re.findall(r'T(\d+)', m.group(3)): out.add((m.group(1), int(x)))
    for m in re.finditer(r'\b(\d{1,2}\.\d{1,2})-T(\d+)\s*(?:[–-]|\.\.|…)\s*T(\d+)', text):
        for i in range(int(m.group(2)), int(m.group(3)) + 1): out.add((m.group(1), i))
    return out
STRICT = '--lenient' not in sys.argv
def verbatim_titles(text):
    """Titles of non-todo node:tests, e.g. test("2.5-T1: Given …", …) — one line each. A title may carry
    backslash-escaped quote characters (spec texts mix ", ' and `); the escapes are removed before comparing."""
    out = set()
    for m in re.finditer(r'\btest\(\s*(["\'`])((?:\\.|(?!\1).)*)\1\s*,', text):
        out.add(re.sub(r'\\(.)', r'\1', m.group(2)))
    return out
live_titles = verbatim_titles(tests_live)
impl_tids = tids_in(tests_live)
if STRICT: impl_tids = {(p['process'], t['n']) for p in manifest for t in p['tids'] if f"{p['process']}-T{t['n']}: {t['text']}" in live_titles}
todo_tids = tids_in(tests_all) - impl_tids
created = set(re.findall(r'CREATE (?:TABLE|VIEW|MATERIALIZED VIEW)\s+(?:IF NOT EXISTS\s+)?(?:restricted_fl\.)?(\w+)', '\n'.join(read(f) for f in glob.glob(os.path.join(root, 'db/migrations/*.sql')))))
lint = json.loads(subprocess.run(['node', '--experimental-strip-types', 'tools/lint-registry.ts', '--json'], cwd=root, capture_output=True, text=True, check=True).stdout)
timer_ok = {t['code'] for t in lint if t['armable'] and t['satisfiable'] and (not STRICT or (t['emitted'] and t['triggered']))}
timer_armable = {t['code'] for t in lint if t['armable']}
authored = set(re.findall(r'\bV\("([A-Z0-9_]+)"', '\n'.join(read(f) for f in glob.glob(os.path.join(root, 'src/notices/**/*.ts'), recursive=True) if not f.endswith('.test.ts'))))
# tools on the bus: (process, spec tool string) pairs that src/app/tools registers (tools/list-tools.ts)
bus_tools = {(t['process'], t['name']) for t in json.loads(subprocess.run(['node', '--experimental-strip-types', 'tools/list-tools.ts'], cwd=root, capture_output=True, text=True, check=True).stdout)}
def cents(s): return int(round(float(s.replace('$', '').replace(',', '')) * 100))

rows = []
for p in manifest:
    pid = p['process']; sec = int(pid.split('.')[0])
    spec_t = {t['n'] for t in p['tids']}
    impl_t = {n for (q, n) in impl_tids if q == pid} & spec_t
    todo_t = {n for (q, n) in todo_tids if q == pid} & spec_t
    tables_ok = [n for n in p['tables'] if n in created or n + 's' in created]
    timers_ok = [c for c in p['timers'] if c in timer_ok]
    notices_ok = [c for c in p['notices'] if c in authored]
    tools_ok = [t for t in p['tools'] if (pid, t) in bus_tools]
    body = read(os.path.join(root, 'spec', p['path']))
    m = re.search(r'#### Business rules(.*?)(?=\n#### )', body, re.S)
    figs = sorted({f for f in re.findall(r'\$[\d,]{1,12}\.\d{2}', m.group(1) if m else '')})
    tt = section_tests.get(sec, ''); flat = tt.replace('_', '')
    figs_ok = [f for f in figs if (f'{cents(f)}n' in flat or f in tt)]
    r = {'process': pid, 'title': p['title'],
         'tids': {'spec': len(spec_t), 'built': len(impl_t), 'todo': len(todo_t), 'missing': sorted(spec_t - impl_t)},
         'tables': {'spec': len(p['tables']), 'built': len(tables_ok), 'missing': [n for n in p['tables'] if n not in tables_ok]},
         'timers': {'spec': len(p['timers']), 'built': len(timers_ok), 'armable': sum(1 for c in p['timers'] if c in timer_armable), 'missing': [c for c in p['timers'] if c not in timers_ok]},
         'notices': {'spec': len(p['notices']), 'built': len(notices_ok), 'missing': [c for c in p['notices'] if c not in notices_ok]},
         'tools': {'spec': len(p['tools']), 'built': len(tools_ok), 'missing': [t for t in p['tools'] if t not in tools_ok]},
         'figures': {'spec': len(figs), 'built': len(figs_ok), 'missing': [f for f in figs if f not in figs_ok]}}
    spec_n = sum(r[u]['spec'] for u in UNITS); built_n = sum(r[u]['built'] for u in UNITS)
    r['units'] = {'spec': spec_n, 'built': built_n}
    r['pct'] = round(100 * built_n / spec_n, 1) if spec_n else 100.0
    rows.append(r)

totals = {u: {'spec': sum(r[u]['spec'] for r in rows), 'built': sum(r[u]['built'] for r in rows)} for u in UNITS}
totals['units'] = {'spec': sum(r['units']['spec'] for r in rows), 'built': sum(r['units']['built'] for r in rows)}
pct = lambda t: round(100 * t['built'] / t['spec'], 1) if t['spec'] else 100.0
frac = lambda t: f"{t['built']}/{t['spec']}"
done = [r['process'] for r in rows if r['units']['built'] == r['units']['spec']]
by_section = collections.OrderedDict()
for r in rows:
    s = by_section.setdefault(int(r['process'].split('.')[0]), {'spec': 0, 'built': 0, 'processes': 0, 'done': 0})
    s['spec'] += r['units']['spec']; s['built'] += r['units']['built']; s['processes'] += 1; s['done'] += r['process'] in done
brief = (f"spec units built {frac(totals['units'])} ({pct(totals['units'])}%): "
         + ', '.join(f"{u} {frac(totals[u])}" for u in UNITS)
         + f"; processes at 100%: {len(done)}/{len(rows)}")

BASELINE = os.path.join(AUDIT, 'baseline.json')
def check():
    """Ratchet: no total may fall below the committed baseline; a process the baseline lists as done stays at 100%."""
    if not os.path.exists(BASELINE): return ['no docs/audit/baseline.json (run: npm run audit:baseline)']
    b = json.load(open(BASELINE)); errs = []
    for u, v in b['totals'].items():
        cur = totals.get(u, {}).get('built', 0)
        if cur < v['built']: errs.append(f"{u} fell to {cur}/{totals[u]['spec']} (baseline {v['built']}/{v['spec']})")
    for pid in b.get('done', []):
        r = next((r for r in rows if r['process'] == pid), None)
        if r is None: errs.append(f"process {pid} marked done is not in the manifest")
        elif r['units']['built'] != r['units']['spec']:
            errs.append(f"process {pid} is marked done but is at {frac(r['units'])} units: " + '; '.join(f"{u} {frac(r[u])}" for u in UNITS if r[u]['built'] != r[u]['spec']))
    return errs

args = sys.argv[1:]
if '--baseline' in args:
    prev = json.load(open(BASELINE)) if os.path.exists(BASELINE) else {}
    json.dump({'totals': totals, 'done': sorted(set(prev.get('done', [])) | set(done), key=lambda s: [int(x) for x in s.split('.')])}, open(BASELINE, 'w'), indent=1)
    print('baseline written: ' + brief); sys.exit(0)
if '--check' in args:
    errs = check()
    if errs:
        print('AUDIT RATCHET FAILED\n  ' + '\n  '.join(errs)); sys.exit(1)
    print('audit ratchet ok: ' + brief); sys.exit(0)
if '--hook' in args:
    event = args[args.index('--hook') + 1] if args.index('--hook') + 1 < len(args) else 'SessionStart'
    errs = check()
    gaps = sorted(rows, key=lambda r: r['units']['spec'] - r['units']['built'], reverse=True)[:5]
    msg = ('Spec audit (tools/audit.py, spec units from spec/registry/manifest.json): ' + brief + '. '
           + ('Ratchet OK.' if not errs else 'RATCHET FAILED: ' + '; '.join(errs)) + ' '
           + 'Largest gaps: ' + ', '.join(f"{r['process']} {frac(r['units'])}" for r in gaps) + '. '
           + 'Report status only as these fractions; a process is done only at 100% of its units.')
    if event == 'Stop':
        out = {'systemMessage': msg}
    else:
        out = {'hookSpecificOutput': {'hookEventName': event, 'additionalContext': msg}}
        if errs: out['systemMessage'] = 'Audit ratchet failing: ' + '; '.join(errs)
    print(json.dumps(out)); sys.exit(0)
if '--brief' in args:
    print(brief); sys.exit(0)
if '--strict' in args:
    print('STRICT ' + brief)
    print('  by section: ' + '  '.join(f"§{k}:{s['built']}/{s['spec']}" for k, s in by_section.items()))
    if '--json' in args: print(json.dumps({'brief': brief, 'totals': totals, 'processes': rows}))
    else:
        for r in rows:
            if r['units']['built'] != r['units']['spec']:
                print(f"  {r['process']:5} {frac(r['units'])}  " + '  '.join(f"{u} {frac(r[u])}" for u in UNITS if r[u]['built'] != r[u]['spec']))
    sys.exit(0)

json.dump({'brief': brief, 'totals': totals, 'sections': {str(k): v for k, v in by_section.items()}, 'done': done, 'processes': rows}, open(os.path.join(AUDIT, 'coverage.json'), 'w'), indent=1)
with open(os.path.join(AUDIT, 'COVERAGE.md'), 'w') as f:
    f.write('# Spec coverage\n\nGenerated by `npm run audit` from `spec/registry/manifest.json`; do not edit. Each unit is one thing the spec names: a T-numbered test, a data-model table, a timer code (armable, satisfiable, and its trigger and satisfied events emitted by source), a notice template, an agent tool on the command bus, or a worked-example figure.\n\n')
    f.write(f'**{brief}**\n\n## Totals\n\n| Unit | Built / spec | % |\n|---|---|---|\n')
    for u in UNITS: f.write(f"| {u} | {frac(totals[u])} | {pct(totals[u])} |\n")
    f.write(f"| **all units** | **{frac(totals['units'])}** | **{pct(totals['units'])}** |\n\n## Sections\n\n| § | Units built / spec | % | Processes at 100% |\n|---|---|---|---|\n")
    for k, s in by_section.items(): f.write(f"| {k} | {s['built']}/{s['spec']} | {round(100*s['built']/s['spec'],1) if s['spec'] else 100} | {s['done']}/{s['processes']} |\n")
    f.write('\n## Processes\n\n| Process | T-ids | tables | timers | notices | tools | figures | units | % |\n|---|---|---|---|---|---|---|---|---|\n')
    for r in rows: f.write(f"| {r['process']} | {frac(r['tids'])} | {frac(r['tables'])} | {frac(r['timers'])} | {frac(r['notices'])} | {frac(r['tools'])} | {frac(r['figures'])} | {frac(r['units'])} | {r['pct']} |\n")
print(brief)
print('  by section: ' + '  '.join(f"§{k}:{s['built']}/{s['spec']}" for k, s in by_section.items()))
print(f"  T-ids scaffolded as todo (not counted): {sum(r['tids']['todo'] for r in rows)}; timers armable but not satisfiable: {sum(r['timers']['armable'] - r['timers']['built'] for r in rows)}")
errs = check()
print(('  ratchet: ' + '; '.join(errs)) if errs else '  ratchet ok')
