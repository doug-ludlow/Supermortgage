"""Scaffold per-process override/evaluator/tool/notice files for §1–§13 (the §14–§19 layout) and wire them
into the four shared aggregators. Idempotent: existing files are left alone; markers guard the wiring."""
import json, os, re, sys
R = '/home/user/Supermortgage'
DIR = {1: 'boarding', 2: 'cashiering', 3: 'escrow', 4: 'servicing-requests', 5: 'investor', 6: 'custodial', 7: 'notices', 8: 'credit-reporting',
       9: 'insurance', 10: 'pmi', 11: 'early-intervention', 12: 'lossmit', 13: 'foreclosure'}
def pdir(pid):
    n, k = (int(x) for x in pid.split('.'))
    return 'transfers' if (n == 1 and k > 1) else DIR[n]
m = json.load(open(f'{R}/spec/registry/manifest.json'))
procs = [p['process'] for p in m if int(p['process'].split('.')[0]) <= 13]
def w(path, text):
    if os.path.exists(path): return False
    open(path, 'w').write(text); return True
made = []
for pid in procs:
    n, k = pid.split('.'); d = pdir(pid); nk = f'{n}_{k}'
    if w(f'{R}/src/domain/{d}/timers-{n}-{k}.ts', f'''/**
 * §{pid} timer overrides (process-owned; the §{n} section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, {{ trigger?, satisfied |
 * evaluator, anchorField?, offset?, why }})` per {pid} registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type {{ TimerRegistry }} from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_{nk}(reg: TimerRegistry): void {{
  const o = reg.override.bind(reg);
  void o; // no {pid} overrides yet — add `o(code, {{ … , why }})` rows here.
}}
'''): made.append(f'timers-{n}-{k}')
    if w(f'{R}/src/domain/{d}/evaluators-{n}-{k}.ts', f'''/**
 * §{pid} gate evaluators, keyed "{pid}.<name>". Every key must be named by an `evaluator:` override in
 * timers-{n}-{k}.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there.
 */
import {{ ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator }} from "../../app/evaluator-kit.ts";

export const EVALUATORS_{nk}: Record<string, Evaluator> = {{}};
export const kit_{nk} = {{ ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears }} as const;
export type {{ PlainDate }};
'''): made.append(f'evaluators-{n}-{k}')
    if w(f'{R}/src/app/tools/section{n}-{k}.ts', f'''/**
 * §{pid} process-owned tools — additional bus tools for {pid} defined with `defineTools("{pid}", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section{int(n):02d}.ts). Every tool string must be one
 * spec/registry/agents.json names for {pid}; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type {{ ToolDef }} from "../tools.ts";

export const TOOLS_{nk}: readonly ToolDef[] = [];
'''): made.append(f'tools/section{n}-{k}')
    if w(f'{R}/src/notices/authored/section{n}-{k}.ts', f'''/**
 * §{pid} process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides; the section's original templates stay in ./section{int(n):02d}.ts. Spread by
 * ../catalog.ts after the section files, so a version here supersedes one there for the same code and effective date.
 */
import type {{ NoticeTemplate, VersionInput }} from "../registry.ts";

export const VERSIONS_{nk}: VersionInput[] = [];
export const OVERRIDES_{nk}: Record<string, Partial<NoticeTemplate>> = {{}};
'''): made.append(f'notices/section{n}-{k}')

def wire(path, imports, marker_import_after, spread_after_list):
    s = open(path).read()
    if '// ---- §1–§13 process-owned files (scaffolded by tools/workflows/wire.py)' in s: return False
    imp = '// ---- §1–§13 process-owned files (scaffolded by tools/workflows/wire.py)\n' + '\n'.join(imports) + '\n'
    assert marker_import_after in s, (path, marker_import_after)
    s = s.replace(marker_import_after, marker_import_after + imp, 1)
    for after, add in spread_after_list:
        assert after in s, (path, after)
        s = s.replace(after, after + add, 1)
    open(path, 'w').write(s); return True

def nk(pid): return pid.replace('.', '_')
def nd(pid): n, k = pid.split('.'); return n, k
# 1. timer-overrides.ts
imports = [f'import {{ applySatisfiedOverrides_{nk(p)} }} from "./{pdir(p)}/timers-{nd(p)[0]}-{nd(p)[1]}.ts";' for p in procs]
calls = ', '.join(f'applySatisfiedOverrides_{nk(p)}' for p in procs)
changed = wire(f'{R}/src/domain/timer-overrides.ts', imports,
     'import { applyDataSecurityTimerOverrides } from "./data-security/timers.ts";\n',
     [('export function applyAllTimerOverrides(reg: TimerRegistry): TimerRegistry {\n  for (const [, apply] of SECTION_OVERRIDES) apply(reg);\n',
       '  for (const apply of PROCESS_OVERRIDES) apply(reg);\n')])
if changed:
    s = open(f'{R}/src/domain/timer-overrides.ts').read()
    s = s.replace('export function applyAllTimerOverrides', f'''/** §1–§13 process-owned overrides (src/domain/<dir>/timers-<n>-<k>.ts), applied after every section's so they win the merge. */
export const PROCESS_OVERRIDES: ReadonlyArray<(reg: TimerRegistry) => void> = [{calls}];

export function applyAllTimerOverrides''', 1)
    open(f'{R}/src/domain/timer-overrides.ts', 'w').write(s)
# 2. app/evaluators.ts
imports = [f'import {{ EVALUATORS_{nk(p)} }} from "../domain/{pdir(p)}/evaluators-{nd(p)[0]}-{nd(p)[1]}.ts";' for p in procs]
wire(f'{R}/src/app/evaluators.ts', imports, 'import { SECTION_19_EVALUATORS } from "../domain/data-security/evaluators.ts";\n',
     [('  ...SECTION_14_EVALUATORS, ...SECTION_15_EVALUATORS, ...SECTION_16_EVALUATORS, ...SECTION_17_EVALUATORS, ...SECTION_18_EVALUATORS, ...SECTION_19_EVALUATORS,\n',
       '  // ---- §1–§13 process-owned maps (spread last: a key here supersedes the inline definition above)\n  ' + ', '.join(f'...EVALUATORS_{nk(p)}' for p in procs) + ',\n')])
# 3. app/tools/index.ts
imports = [f'import {{ TOOLS_{nk(p)} }} from "./section{nd(p)[0]}-{nd(p)[1]}.ts";' for p in procs]
wire(f'{R}/src/app/tools/index.ts', imports, 'import { SECTION_19_TOOLS } from "./section19.ts";\n',
     [('...SECTION_18_TOOLS, ...SECTION_19_TOOLS]', None)]) if False else None
s = open(f'{R}/src/app/tools/index.ts').read()
if 'wire.py' not in s:
    s = s.replace('import { SECTION_19_TOOLS } from "./section19.ts";\n', 'import { SECTION_19_TOOLS } from "./section19.ts";\n// ---- §1–§13 process-owned files (scaffolded by tools/workflows/wire.py)\n' + '\n'.join(imports) + '\n', 1)
    old = '...SECTION_18_TOOLS, ...SECTION_19_TOOLS];'
    assert old in s
    s = s.replace(old, '...SECTION_18_TOOLS, ...SECTION_19_TOOLS,\n  ' + ', '.join(f'...TOOLS_{nk(p)}' for p in procs) + '];', 1)
    open(f'{R}/src/app/tools/index.ts', 'w').write(s)
# 4. notices/catalog.ts
imports = [f'import {{ VERSIONS_{nk(p)}, OVERRIDES_{nk(p)} }} from "./authored/section{nd(p)[0]}-{nd(p)[1]}.ts";' for p in procs]
wire(f'{R}/src/notices/catalog.ts', imports, 'import { SECTION_19_VERSIONS, SECTION_19_OVERRIDES } from "./authored/section19.ts";\n',
     [('  ...SECTION_19_OVERRIDES,\n', '  ' + ', '.join(f'...OVERRIDES_{nk(p)}' for p in procs) + ',\n'),
      ('  ...SECTION_19_VERSIONS,\n', '  ' + ', '.join(f'...VERSIONS_{nk(p)}' for p in procs) + ',\n')])
print('stubs created:', len(made)); print('wired')
