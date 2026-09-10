# Section NN — Section title

<!--
  Save as spec/sections/NN-section-slug/README.md. `npm run spec:register` reads the H1 for the section
  title and lists the section's N-M-*.md process files. The section number continues the servicing series;
  the suggested origination and platform series is:

    20  Application & disclosures          (intake, MLO assignment, LE, consents, pricing and lock)
    21  Underwriting & decision            (credit, income, assets, collateral, AUS, conditions, decision, adverse action)
    22  Closing, funding & delivery        (CD, e-closing, funding, warehouse, MERS registration, investor delivery, custodian)
    23  Refinance                          (a new application that consumes 16.x payoff and retires the prior loan)
    24  Identity, accounts & licensing     (consumers, workforce with license registry, partners; consent; access logging)
    25  Documents & e-signature            (store, hashes, retention, redaction, e-sign evidence, eVault)
    26  Agent runtime & governance         (runner, tiers, propose-only mode, evaluation sets, kill switches, LL-2026-04 inventory)
-->

## Overview

What the section covers, from the first triggering event to the last terminal state, and which agents execute it. Which capacity Supermortgage acts in (lender, servicer, subservicer) and where the boundary with partners sits.

Dependencies: which earlier sections this consumes (events, tables) and which later sections consume its outputs.

Changes in flight that shape the build: rule editions, effective dates, retired systems.

## Processes

| Process | Title | Automation class |
|---|---|---|
| NN.1 | … | a |
| NN.2 | … | b |

## Closing

Section-level test plan and sequencing: build order across the processes, the shared fixtures (a synthetic application, a synthetic borrower), and the section-level acceptance run.
