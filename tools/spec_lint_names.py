#!/usr/bin/env python3
"""Shared-name lint across the origination (20–31) and servicing (1–19) sides of the spec — the mechanical form of the
"one seamless product" rule: a name means one thing everywhere.

  python3 tools/spec_lint_names.py            report; exit 1 on a hard finding
  python3 tools/spec_lint_names.py --verbose  also list the soft findings (reference rows, unknown tables)

Hard findings (exit 1):
  timer-redefinition   a timer code first defined in a lower-numbered section is re-triggered by a different event
                       type in a higher-numbered section (the registry lets the first section own the code, so the
                       later row would silently arm on the wrong event). Fix: give the later row its own code, defined
                       as a variant of the shared rule, or make it a reference row with the same trigger.
  unknown-agent        an agent named in an "AI agent design" paragraph that tools/extract_agents.py KNOWN lacks.
  unknown-role         a human role named in backticks in a timers/guardrails context that src/app/roles.ts lacks.
  unknown-calendar     a `business_days_*` unit the kernel does not define (src/kernel/calendar/business.ts DAY_UNITS).
Soft findings (--verbose):
  reference-row        a later section restates a shared timer with the same trigger (allowed; it references, never owns).
  shared-table-missing a table an origination file marks as servicing-owned ("(1.1)", "shared with 9.x", "baseline")
                       that no migration creates yet.
"""
import re, glob, json, os, sys, collections
root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
verbose = '--verbose' in sys.argv
sys.path.insert(0, os.path.join(root, 'tools'))

def read(p): return open(p, encoding='utf-8').read()
def section_of(pid): return int(pid.split('.')[0])
def event_type(cell):
    m = re.search(r'`([a-z_]+(?:\.[a-z_*]+)+)', cell) or re.search(r'\b([a-z_]+\.[a-z_]+(?:\.[a-z_]+)*)\b', cell)
    return m.group(1) if m else None

hard, soft = [], []

# ---- timers: one code, one trigger
timers = json.load(open(os.path.join(root, 'spec/registry/timers.json')))
by = collections.defaultdict(list)
for t in timers: by[t['code']].append(t)
for code, rows in by.items():
    servicing = [r for r in rows if section_of(r['process']) < 20]
    origination = [r for r in rows if section_of(r['process']) >= 20]
    if not servicing or not origination: continue
    # the registry (src/kernel/timers/registry.ts) lets the servicing side own a shared code; every trigger event type the
    # servicing rows name is a legitimate trigger, anything else in an origination row is a redefinition
    canon = {event_type(r['trigger']) for r in servicing} - {None}
    for r in origination:
        b = event_type(r['trigger'])
        if b is None or not canon or b in canon:
            soft.append(f"reference-row      {code}: {r['process']} restates the servicing timer ({', '.join(sorted(x['process'] for x in servicing))})")
        else:
            hard.append(f"timer-redefinition {code}: servicing ({', '.join(sorted(x['process'] for x in servicing))}) triggers on {sorted(canon)}, {r['process']} re-triggers on `{b}`")

# ---- agents, roles, calendars named by the markdown
_ea = read(os.path.join(root, 'tools/extract_agents.py'))  # its module body runs the extraction, so read the sets textually
KNOWN = set(re.findall(r'"([a-z\-]+)"', re.search(r'KNOWN = \{(.*?)\}', _ea, re.S).group(1)))
ROLES = set(re.findall(r'"([a-z_]+)"', re.search(r'ROLES = \{(.*?)\}', _ea, re.S).group(1)))
kernel_roles = set(re.findall(r'"([a-z_]+)"', re.search(r'HUMAN_ROLES = \[(.*?)\] as const', read(os.path.join(root, 'src/app/roles.ts')), re.S).group(1)))
kernel_units = set(re.findall(r'"(calendar_days|business_days_[a-z_]+)"', re.search(r'DAY_UNITS[^\n]*\n', read(os.path.join(root, 'src/kernel/calendar/business.ts'))).group(0)))
created = set(re.findall(r'CREATE (?:TABLE|VIEW|MATERIALIZED VIEW)\s+(?:IF NOT EXISTS\s+)?(?:restricted_fl\.)?(\w+)', '\n'.join(read(f) for f in glob.glob(os.path.join(root, 'db/migrations/*.sql')))))
for f in sorted(glob.glob(os.path.join(root, 'spec/sections/*/*.md'))):
    m = re.match(r'(\d+)-(\d+)-', os.path.basename(f))
    if not m: continue
    pid = f'{m.group(1)}.{m.group(2)}'; text = read(f)
    pm = re.search(r'#### AI agent design[^\n]*\n(.*?)(?=\n#### |\Z)', text, re.S)
    if pm:
        para = pm.group(1)
        am = re.match(r'\s*`([a-z][a-z\-]+)` agent', para)
        if am and am.group(1) not in KNOWN: hard.append(f"unknown-agent      {pid}: `{am.group(1)}` (add to tools/extract_agents.py KNOWN)")
    for role in set(re.findall(r'`([a-z_]+)`', text)) & (ROLES | kernel_roles):
        if role not in kernel_roles: hard.append(f"unknown-role       {pid}: `{role}` is in the extractor's ROLES but not src/app/roles.ts HUMAN_ROLES")
    for unit in set(re.findall(r'business_days_[a-z_]+', text)):
        if unit not in kernel_units and not unit.startswith(('business_days_after', 'business_days_since', 'business_days_to', 'business_days_before')):
            hard.append(f"unknown-calendar   {pid}: `{unit}` is not a kernel DayUnit")
    if section_of(pid) >= 20:
        dm = re.search(r'#### Data model(.*?)(?=\n#### )', text, re.S)
        if dm:
            for name, tail in re.findall(r'(?:^|\n)\s*[-*]\s*\*{0,2}`([a-z][a-z0-9_]{3,})`\*{0,2}\s*\(((?:shared with|baseline|servicing)[^)]*)\)', dm.group(1)):
                if name not in created and name + 's' not in created and not name.endswith(('_id', '_at', '_on', '_cents', '_pct', '_date', '_flag', '_until', '_code', '_bps')) and not re.search(r'_(\d+[ymd]|life|class)\b', name):
                    soft.append(f"shared-table-missing {pid}: `{name}` ({tail[:60]}) — no migration creates it")

hard = sorted(set(hard)); soft = sorted(set(soft))
for h in hard: print(h)
if verbose:
    for s in soft: print(s)
print(f"spec name lint: {len(hard)} hard, {len(soft)} soft findings" + ('' if verbose else ' (--verbose lists the soft ones)'))
sys.exit(1 if hard else 0)
