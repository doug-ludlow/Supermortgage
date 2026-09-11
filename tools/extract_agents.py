#!/usr/bin/env python3
"""Extract the agent layer the spec defines into spec/registry/agents.json:
for every process, the owning agent(s) named in its "AI agent design" paragraph, the backticked tool
names listed there, the guardrails sentence and the escalation roles. Agents are then aggregated:
{agent, processes[], tools[], escalates_to[]}."""
import re, glob, json, os, collections
root = os.path.join(os.path.dirname(__file__), '..')
KNOWN = {"boarding","transfer","custodial-recon","escrow","lossmit-underwriter","investor-reporting","security-records","compliance-sentinel","cashiering","case","borrower-comms","disclosures","credit-reporting","insurance-property","pmi","default-collections","foreclosure-ops","bankruptcy-ops","claims-reo","payoff-release","qc-audit",
         "intake","pricing","disclosure","verification","fraud-risk","underwriter","valuation","title-closing","compliance-tester","funder","warehouse","post-closing","secondary","hmda"}
ROLES = {"officer","attorney","signing_officer","fnma_portal_operator","human_agent","lossmit_reviewer","fraud_officer","ciso","compliance","counsel",
         "mlo_of_record","underwriting_reviewer","notary","settlement_agent","closing_attorney","appraiser","property_data_collector","funding_approver","bsa_officer","qc_officer","licensed_specialist"}
per_process = []
agents = collections.OrderedDict()
for f in sorted(glob.glob(os.path.join(root, 'spec/sections/*/*.md'))):
    name = os.path.basename(f); m = re.match(r'(\d+)-(\d+)-', name)
    if not m: continue
    proc = f"{m.group(1)}.{m.group(2)}"
    text = open(f).read()
    # the agent-design paragraph: from "AI agent design" (or "Agent design") to the next blank line
    pm = re.search(r'#### (?:AI agent design|Agent design|AI-agent design)[^\n]*\n', text, re.I)
    para = ""
    if pm:
        start = pm.end(); nxt = re.search(r'\n#### ', text[start:]); para = text[start:start + nxt.start()] if nxt else text[start:start + 6000]
    else:
        para = text
    names = [a for a in re.findall(r'`([a-z][a-z\-]+)`', para) if a in KNOWN]
    owner = names[0] if names else None
    tools = []
    tm = re.search(r'tools?(?: allowlist)?[^`{]{0,20}[{(]?\s*((?:`[A-Za-z0-9_./*\- ]+`\s*(?:\([^)]*\))?\s*(?:,|and)?\s*){2,})', para, re.I)
    if tm:
        tools = re.findall(r'`([A-Za-z][A-Za-z0-9_./*\-]*)`', tm.group(1))
    else:
        tools = [t for t in re.findall(r'`([a-z][A-Za-z0-9]+)`', para) if re.match(r'^[a-z]+[A-Z]', t)]
    tools = list(dict.fromkeys(t for t in tools if t not in KNOWN))
    gm = re.search(r'Guardrails:\*?\*?\s*([^\n]{0,600})', text)
    guard = gm.group(1).strip() if gm else ""
    esc = sorted({r for r in re.findall(r'`([a-z_]+)`', text) if r in ROLES})
    per_process.append({"process": proc, "agent": owner, "agents_named": list(dict.fromkeys(names)), "tools": tools, "guardrails": guard[:600], "escalates_to": esc})
    if owner:
        a = agents.setdefault(owner, {"agent": owner, "processes": [], "tools": [], "escalates_to": []})
        a["processes"].append(proc)
        for t in tools:
            if t not in a["tools"]: a["tools"].append(t)
        for r in esc:
            if r not in a["escalates_to"]: a["escalates_to"].append(r)
out = {"agents": list(agents.values()), "processes": per_process}
with open(os.path.join(root, 'spec/registry/agents.json'), 'w') as fh: json.dump(out, fh, indent=1)
print(len(agents), "agents;", sum(1 for p in per_process if p["agent"]), "/", len(per_process), "processes with an owner;", sum(len(a["tools"]) for a in agents.values()), "tools")
for a in agents.values(): print(f"  {a['agent']:22} {len(a['processes']):3} procs {len(a['tools']):3} tools  {a['processes'][:6]}")
print("no owner:", [p["process"] for p in per_process if not p["agent"]])
