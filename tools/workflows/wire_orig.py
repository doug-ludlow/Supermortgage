#!/usr/bin/env python3
"""Scaffold the per-process build layout for the origination sections (20–31) and wire it into the four shared
aggregators — the same ownership the §14–§19 build used (see wire.py for §1–§13). Idempotent: existing files are left
alone; a marker guards each wiring block.

  python3 tools/workflows/wire_orig.py          scaffold + wire every registered process of sections 20–31
"""
import json, os, re
R = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
DIR = {20: 'leads-pricing', 21: 'application', 22: 'verification', 23: 'underwriting', 24: 'property', 25: 'compliance-disclosures',
       26: 'closing', 27: 'warehouse', 28: 'qc-hmda', 29: 'secondary', 30: 'orig-boarding', 31: 'governance'}
m = json.load(open(f'{R}/spec/registry/manifest.json'))
procs = [p['process'] for p in m if int(p['process'].split('.')[0]) in DIR]
def pdir(pid): return DIR[int(pid.split('.')[0])]
def w(path, text):
    if os.path.exists(path): return False
    os.makedirs(os.path.dirname(path), exist_ok=True); open(path, 'w').write(text); return True
made = []
for pid in procs:
    n, k = pid.split('.'); d = pdir(pid); nk = f'{n}_{k}'
    if w(f'{R}/src/domain/{d}/timers-{n}-{k}.ts', f'''/**
 * §{pid} timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, {{ trigger?, satisfied | evaluator,
 * anchorField?, offset?, why }})` per {pid} registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 */
import type {{ TimerRegistry }} from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_{nk}(reg: TimerRegistry): void {{
  const o = reg.override.bind(reg);
  void o; // no {pid} overrides yet — add `o(code, {{ … , why }})` rows here.
}}
'''): made.append(f'timers-{n}-{k}')
    if w(f'{R}/src/domain/{d}/evaluators-{n}-{k}.ts', f'''/**
 * §{pid} gate evaluators, keyed "{pid}.<name>". Every key must be named by an `evaluator:` override in
 * timers-{n}-{k}.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import {{ ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator }} from "../../app/evaluator-kit.ts";

export const EVALUATORS_{nk}: Record<string, Evaluator> = {{}};
export const kit_{nk} = {{ ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears }} as const;
export type {{ PlainDate }};
'''): made.append(f'evaluators-{n}-{k}')
    if w(f'{R}/src/app/tools/section{n}-{k}.ts', f'''/**
 * §{pid} process-owned tools — bus tools for {pid} defined with `defineTools("{pid}", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for {pid}; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type {{ ToolDef }} from "../tools.ts";

export const TOOLS_{nk}: readonly ToolDef[] = [];
'''): made.append(f'tools/section{n}-{k}')
    if w(f'{R}/src/notices/authored/section{n}-{k}.ts', f'''/**
 * §{pid} process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 */
import type {{ NoticeTemplate, VersionInput }} from "../registry.ts";

export const VERSIONS_{nk}: VersionInput[] = [];
export const OVERRIDES_{nk}: Record<string, Partial<NoticeTemplate>> = {{}};
'''): made.append(f'notices/section{n}-{k}')

MARK = '// ---- §20–§31 process-owned files (scaffolded by tools/workflows/wire_orig.py)'
def nk(pid): return pid.replace('.', '_')
def nd(pid): return pid.split('.')
def wire(path, imports, import_after, spread_pairs):
    s = open(path).read()
    if MARK in s: return False
    assert import_after in s, (path, import_after)
    s = s.replace(import_after, import_after + MARK + '\n' + '\n'.join(imports) + '\n', 1)
    for after, add in spread_pairs:
        assert after in s, (path, after[:60])
        s = s.replace(after, after + add, 1)
    open(path, 'w').write(s); return True

# 1. timer-overrides.ts — PROCESS_OVERRIDES gains the origination process functions (after the §1–§13 list)
imports = [f'import {{ applySatisfiedOverrides_{nk(p)} }} from "./{pdir(p)}/timers-{nd(p)[0]}-{nd(p)[1]}.ts";' for p in procs]
s = open(f'{R}/src/domain/timer-overrides.ts').read()
if MARK not in s:
    anchor = 'import { applySatisfiedOverrides_13_9 } from "./foreclosure/timers-13-9.ts";\n'
    assert anchor in s
    s = s.replace(anchor, anchor + MARK + '\n' + '\n'.join(imports) + '\n', 1)
    old = 'applySatisfiedOverrides_13_9];'
    assert old in s
    s = s.replace(old, 'applySatisfiedOverrides_13_9,\n  ' + ', '.join(f'applySatisfiedOverrides_{nk(p)}' for p in procs) + '];', 1)
    open(f'{R}/src/domain/timer-overrides.ts', 'w').write(s)
# 2. app/evaluators.ts
imports = [f'import {{ EVALUATORS_{nk(p)} }} from "../domain/{pdir(p)}/evaluators-{nd(p)[0]}-{nd(p)[1]}.ts";' for p in procs]
wire(f'{R}/src/app/evaluators.ts', imports, 'import { EVALUATORS_13_9 } from "../domain/foreclosure/evaluators-13-9.ts";\n',
     [('...EVALUATORS_13_9,\n', '  ' + ', '.join(f'...EVALUATORS_{nk(p)}' for p in procs) + ',\n')])
# 3. app/tools/index.ts
imports = [f'import {{ TOOLS_{nk(p)} }} from "./section{nd(p)[0]}-{nd(p)[1]}.ts";' for p in procs]
s = open(f'{R}/src/app/tools/index.ts').read()
if MARK not in s:
    anchor = 'import { TOOLS_13_9 } from "./section13-9.ts";\n'
    assert anchor in s
    s = s.replace(anchor, anchor + MARK + '\n' + '\n'.join(imports) + '\n', 1)
    old = '...TOOLS_13_9];'
    assert old in s
    s = s.replace(old, '...TOOLS_13_9,\n  ' + ', '.join(f'...TOOLS_{nk(p)}' for p in procs) + '];', 1)
    open(f'{R}/src/app/tools/index.ts', 'w').write(s)
# 4. notices/catalog.ts
imports = [f'import {{ VERSIONS_{nk(p)}, OVERRIDES_{nk(p)} }} from "./authored/section{nd(p)[0]}-{nd(p)[1]}.ts";' for p in procs]
wire(f'{R}/src/notices/catalog.ts', imports, 'import { VERSIONS_13_9, OVERRIDES_13_9 } from "./authored/section13-9.ts";\n',
     [('...OVERRIDES_13_9,\n', '  ' + ', '.join(f'...OVERRIDES_{nk(p)}' for p in procs) + ',\n'),
      ('...VERSIONS_13_9,\n', '  ' + ', '.join(f'...VERSIONS_{nk(p)}' for p in procs) + ',\n')])
print('stubs created:', len(made)); print('wired', len(procs), 'processes')
