#!/usr/bin/env python3
"""Extract the Supermortgage build spec from the published artifact payload into
version-controlled markdown + machine-readable registries under spec/.

The artifact embeds a gzip+base64 JSON payload in <script id="payload">.
Run:  python3 tools/extract_spec.py <artifact.html> [--out spec]
"""
import argparse, base64, gzip, json, os, re, sys, unicodedata

def slug(text, maxlen=60):
    t = unicodedata.normalize("NFKD", text)
    t = t.encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-zA-Z0-9]+", "-", t).strip("-").lower()
    return t[:maxlen].rstrip("-")

def load_payload(path):
    html = open(path, encoding="utf8", errors="replace").read()
    m = re.search(r'<script id="payload"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        sys.exit("no <script id=payload> block found in artifact")
    return json.loads(gzip.decompress(base64.b64decode(m.group(1).strip())))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact")
    ap.add_argument("--out", default="spec")
    args = ap.parse_args()

    data = load_payload(args.artifact)
    sections = data["specs"]["sections"]
    timers = data["timers"]
    out = args.out

    process_index, section_index = [], []
    for sec in sections:
        sec_dir = os.path.join(out, "sections", f"{sec['n']:02d}-{slug(sec['title'])}")
        os.makedirs(sec_dir, exist_ok=True)
        with open(os.path.join(sec_dir, "README.md"), "w") as f:
            f.write(f"# Section {sec['n']} — {sec['title']}\n\n## Overview\n\n{sec['overview']}\n")
            if sec.get("closing"):
                f.write(f"\n## Closing\n\n{sec['closing']}\n")
        procs = []
        for p in sec["processes"]:
            fname = f"{p['id'].replace('.', '-')}-{slug(p['title'])}.md"
            meta = p.get("meta", {})
            with open(os.path.join(sec_dir, fname), "w") as f:
                f.write(f"# {p['id']} — {p['title']}\n\n")
                f.write("| Attribute | Value |\n|---|---|\n")
                f.write(f"| Section | {sec['n']} — {sec['title']} |\n")
                for k, label in (("auto", "Automation class"), ("own", "SoR / Sub"),
                                 ("trigger", "Trigger & frequency"), ("source", "Governing source"),
                                 ("deadline", "Key deadlines")):
                    if meta.get(k):
                        f.write(f"| {label} | {meta[k]} |\n")
                f.write(f"| Timers | {', '.join(f'`{t}`' for t in p.get('timers', [])) or '—'} |\n\n")
                f.write(p["md"].rstrip() + "\n")
            rec = {"id": p["id"], "title": p["title"], "section": sec["n"],
                   "section_title": sec["title"], "words": p.get("words", 0),
                   "timers": p.get("timers", []), "subsections": p.get("subs", []),
                   "path": os.path.relpath(os.path.join(sec_dir, fname), out), **meta}
            process_index.append(rec)
            procs.append(p["id"])
        section_index.append({"n": sec["n"], "title": sec["title"],
                              "path": os.path.relpath(sec_dir, out), "processes": procs})

    os.makedirs(os.path.join(out, "registry"), exist_ok=True)
    def dump(name, obj):
        with open(os.path.join(out, "registry", name), "w") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.write("\n")
    dump("sections.json", section_index)
    dump("processes.json", process_index)
    dump("timers.json", timers)

    print(f"{len(section_index)} sections, {len(process_index)} processes, {len(timers)} timers -> {out}/")

if __name__ == "__main__":
    main()
