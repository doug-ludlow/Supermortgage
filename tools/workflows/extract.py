"""extract.py <task output file>... → writes findings_<item>.json for every item whose last review still has block findings, prints fix-loop args."""
import json, sys
S='/tmp/claude-0/-home-user-Supermortgage/aa54bc9f-385e-5d56-883d-de5f227fcfeb/scratchpad'
A=json.load(open('/home/user/Supermortgage/tools/workflows/args.json'))
procs={p['id']:p for p in A['process_build']['processes']}
secs={s['n']:s for s in A['section_review']['sections']}
items=[]; disc=[]; shared=[]
for path in sys.argv[1:]:
    try: d=json.load(open(path))['result']
    except Exception as e: print('UNPARSEABLE', path, e); continue
    for r in d:
        if r.get('failed'): print('FAILED item in', path, r); continue
        last = r.get('verify2') or r.get('review2') or r.get('verify1') or r.get('review1') or {}
        f = last.get('findings', [])
        fix = r.get('fix') or {}
        for x in (fix.get('discrepancies') or (r.get('build') or {}).get('discrepancies') or []): disc.append(x)
        for x in (fix.get('shared_file_changes_needed') or []): shared.append(x)
        blocks=[x for x in f if x['severity']=='block']
        if 'process' in r:
            pid=r['process']; p=procs[pid]; name=pid.replace('.','_')
            print(f"{pid}: {len(blocks)} block / {len(f)-len(blocks)} warn remain")
            if blocks:
                fp=f"{S}/findings_{name}.json"; json.dump(f, open(fp,'w'), indent=1)
                items.append({"id":pid,"kind":"process","dir":p['dir'],"n":p['n'],"k":p['k'],"mig":p['mig'],"title":p['title'],"findings_file":fp})
        else:
            n=r['section']; s=secs[n]
            print(f"§{n}: {len(blocks)} block / {len(f)-len(blocks)} warn remain")
            if blocks:
                fp=f"{S}/findings_sec{n}.json"; json.dump(f, open(fp,'w'), indent=1)
                items.append({"id":f"§{n}","kind":"section","dirs":s['dirs'],"n":n,"pad":s['pad'],"title":s['title'],"findings_file":fp})
json.dump({"scratch":S,"max_rounds":3,"items":items}, open(f"{S}/fixloop_args.json",'w'))
print('ARGS:', json.dumps({"scratch":S,"max_rounds":3,"items":items}))
if disc: print('DISCREPANCIES:', json.dumps(disc)[:1500])
if shared: print('SHARED:', shared)
