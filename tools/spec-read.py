#!/usr/bin/env python3
"""Print selected subsections of process specs: tools/spec-read.py 2.3 2.4 [--parts rules,state,tests,data,timers,edge] [--max 4000]"""
import json, sys, re
args=[a for a in sys.argv[1:] if not a.startswith('--')]
opts={a.split('=')[0][2:]:a.split('=')[1] for a in sys.argv[1:] if a.startswith('--') and '=' in a}
parts=opts.get('parts','state,rules,tests').split(',')
mx=int(opts.get('max','4000'))
heads={'data':'#### Data model','state':'#### State machine','rules':'#### Business rules','timers':'#### Timers and gates','tests':'#### Test cases','edge':'#### Edge cases','inputs':'#### Inputs and triggers','integ':'#### Integrations','ai':'#### AI agent','outputs':'#### Outputs','open':'### Open questions'}
idx={p['id']:p for p in json.load(open('spec/registry/processes.json'))}
for pid in args:
    p=idx[pid]; md=open('spec/'+p['path']).read()
    print(f"\n######## {pid} {p['title']}")
    for part in parts:
        h=heads[part]; i=md.find(h)
        if i<0: continue
        j=md.find('\n### ', i+5); j2=md.find('\n#### ', i+5)
        ends=[x for x in (j,j2) if x>0]; j=min(ends) if ends else len(md)
        body=md[i:j].strip()
        print(body[:mx] + ('\n[...truncated]' if len(body)>mx else ''))
