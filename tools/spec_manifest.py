#!/usr/bin/env python3
"""Per-process manifest of everything the spec requires, in the spec's own units:
T-ids (with their verbatim text), data-model tables, timer codes, notice codes, agent tools.
Writes spec/registry/manifest.json. The audit and the task list both read this file, so the plan and
the measurement share one source."""
import re, glob, json, os
root = os.path.join(os.path.dirname(__file__), '..')
procs = json.load(open(os.path.join(root, 'spec/registry/processes.json')))
timers = json.load(open(os.path.join(root, 'spec/registry/timers.json')))
notices = json.load(open(os.path.join(root, 'spec/registry/notices.json')))
agents = json.load(open(os.path.join(root, 'spec/registry/agents.json')))
tools_by_proc = {p['process']: p['tools'] for p in agents['processes']}
agent_by_proc = {p['process']: p['agent'] for p in agents['processes']}
timers_by_proc = {}
for t in timers: timers_by_proc.setdefault(t['process'], set()).add(t['code'])
notices_by_proc = {}
# A handful of `INS_*` registry rows in notices.json are timer codes (INS_EXPIRATION_WATCH_60, INS_CLAIM_STALE_90 ...);
# they are counted once, as timers, never as notice templates.
timer_codes = {t['code'] for t in timers}
for n in notices:
    if n['code'] in timer_codes: continue
    notices_by_proc.setdefault(n['owner_process'], []).append(n['code'])

def tid_texts(pid, text):
    """T-id → verbatim Given/When/Then text (table rows `| 2.1-T1 | … |` or bullets `- 2.1-T1 …`)."""
    out = {}
    for m in re.finditer(r'^\|\s*' + re.escape(pid) + r'-T(\d+)[A-Za-z]?\s*\|\s*(.*?)\s*\|\s*$', text, re.M):
        out.setdefault(int(m.group(1)), m.group(2).strip())
    for m in re.finditer(r'^\s*[-*]\s*' + re.escape(pid) + r'-T(\d+)[A-Za-z]?\s+(.*?)$', text, re.M):
        out.setdefault(int(m.group(1)), m.group(2).strip())
    for m in re.finditer(r'^\s*[-*]\s*\*\*' + re.escape(pid) + r'-T(\d+)[A-Za-z]?\s*(\([^)]*\))?\s*[:.]?\*\*:?\s*(.*?)$', text, re.M):
        label = (m.group(2) + ' ' if m.group(2) else '')
        out.setdefault(int(m.group(1)), (label + m.group(3)).strip())
    for m in re.finditer(r'\b' + re.escape(pid) + r'-T(\d+)\b', text):
        out.setdefault(int(m.group(1)), '')
    return dict(sorted(out.items()))

def tables(text):
    m = re.search(r'#### Data model(.*?)(?=\n#### )', text, re.S)
    names = set()
    if m:
        for n in re.findall(r'(?:^|\n)\s*[-*]\s*\*{0,2}`([a-z][a-z0-9_]{3,})`', m.group(1)):
            if not n.endswith(('_id', '_at', '_on', '_cents', '_pct', '_date', '_flag')) and '.' not in n: names.add(n)
        for n, tail in re.findall(r'`([a-z][a-z0-9_]{3,})`\s*\(((?:baseline|new|extended|append-only)[^)]*)\)', m.group(1)):
            if 'retention class' not in tail and 'enum' not in tail: names.add(n)
        # `x` (new retention class …) / `mode` ∈ {…} are classes and enums, not tables
        for n in list(names):
            if re.search(r'`' + re.escape(n) + r'`\s*\((?:new )?retention class', m.group(1)) or re.search(r'`' + re.escape(n) + r'`\s*[∈=]', m.group(1)): names.discard(n)
    return sorted(names)

manifest = []
for p in procs:
    text = open(os.path.join(root, 'spec', p['path'])).read()
    tids = tid_texts(p['id'], text)
    manifest.append({'process': p['id'], 'title': p['title'], 'path': p['path'],
                     'tids': [{'n': n, 'text': t} for n, t in tids.items()],
                     'tables': tables(text), 'timers': sorted(timers_by_proc.get(p['id'], [])),
                     'notices': sorted(notices_by_proc.get(p['id'], [])),
                     'agent': agent_by_proc.get(p['id']), 'tools': tools_by_proc.get(p['id'], [])})
json.dump(manifest, open(os.path.join(root, 'spec/registry/manifest.json'), 'w'), indent=1)
tot = {k: sum(len(m[k]) for m in manifest) for k in ('tids', 'tables', 'timers', 'notices', 'tools')}
with_text = sum(1 for m in manifest for t in m['tids'] if t['text'])
print(f"{len(manifest)} processes; " + ', '.join(f"{k} {v}" for k, v in tot.items()) + f"; T-ids with verbatim text {with_text}/{tot['tids']}")
