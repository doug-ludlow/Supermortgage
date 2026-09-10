#!/usr/bin/env python3
"""Extract every NTC_/INS_ notice template code the spec names into spec/registry/notices.json.
For each code: the owning process (first process whose text names it), every process that mentions it,
and the sentence/table row it first appears in (its citation context)."""
import re, glob, json, os, collections
root = os.path.join(os.path.dirname(__file__), '..')
codes = collections.OrderedDict()
for f in sorted(glob.glob(os.path.join(root, 'spec/sections/*/*.md'))):
    name = os.path.basename(f)
    m = re.match(r'(\d+)-(\d+)-', name)
    if not m: continue
    proc = f"{m.group(1)}.{m.group(2)}"
    text = open(f).read()
    for line in text.splitlines():
        for t in re.findall(r'`((?:NTC|INS)_[A-Z0-9_]+)`', line):
            e = codes.setdefault(t, {"code": t, "owner_process": proc, "mentions": [], "context": line.strip()[:400]})
            if proc not in e["mentions"]: e["mentions"].append(proc)
out = sorted(codes.values(), key=lambda e: (tuple(int(x) for x in e["owner_process"].split('.')), e["code"]))
with open(os.path.join(root, 'spec/registry/notices.json'), 'w') as fh:
    json.dump(out, fh, indent=1)
print(len(out), "notice codes written")
