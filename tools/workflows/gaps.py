import json, sys
sec = sys.argv[1]
c=json.load(open('docs/audit/coverage.json'))
m=json.load(open('spec/registry/manifest.json'))
procs = c['processes'] if isinstance(c,dict) and 'processes' in c else c
mp = {p['process']: p for p in (m['processes'] if isinstance(m,dict) and 'processes' in m else m)}
for r in procs:
    pid = r.get('process') or r.get('id')
    if not str(pid).startswith(sec + '.'): continue
    print(f"== {pid} {r.get('title','')} units {r['units']['built']}/{r['units']['spec']} | {mp[pid]['path']} | agent {mp[pid].get('agent')}")
    tt = {t['n']: t['text'] for t in mp[pid]['tids']}
    for u in ('tids','tables','timers','notices','tools','figures'):
        miss = r[u].get('missing', [])
        if not miss: continue
        if u=='tids':
            for t in miss:
                n = int(str(t).split('T')[-1])
                print(f"  {pid}-T{n}: {tt.get(n, '')[:450]}")
        else: print(f"  {u} missing: {miss}")
