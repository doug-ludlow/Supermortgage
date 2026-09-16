#!/usr/bin/env python3
"""Assemble src/domain/operations-runtime/35-5.spec.test.ts from the manifest's exact T-id titles: the harness
(tools/s35_5/harness.ts.txt), one `test(<title>, …)` per T-id with its body from tools/s35_5/bodies/T<n>.ts.txt, and the
scaffold's `{ todo: true }` line for a T-id that has no body yet. Titles are the manifest JSON text, never typed by hand."""
import json, os, sys
root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
m = json.load(open(os.path.join(root, 'spec/registry/manifest.json')))
p = next(x for x in m if x['process'] == '35.5')
out = [open(os.path.join(root, 'tools/s35_5/harness.ts.txt')).read().rstrip('\n'), '']
for t in p['tids']:
    title = f"35.5-T{t['n']}: {t['text']}"
    body_path = os.path.join(root, f"tools/s35_5/bodies/T{t['n']}.ts.txt")
    if os.path.exists(body_path):
        out.append(f"test({json.dumps(title, ensure_ascii=False)}, {{ skip }}, async () => {{\n{open(body_path).read().rstrip()}\n}});\n")
    else:
        out.append(f"test({json.dumps(title, ensure_ascii=False)}, {{ todo: true }});")
open(os.path.join(root, 'src/domain/operations-runtime/35-5.spec.test.ts'), 'w').write('\n'.join(out) + '\n')
print('written', sum(1 for t in p['tids'] if os.path.exists(os.path.join(root, f"tools/s35_5/bodies/T{t['n']}.ts.txt"))), 'bodies')
