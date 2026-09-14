# `src/infra/integrations/du-schema` — the vendored DU schema chain and Fannie's eighteen samples

Nothing in `xsd/` or `samples/` is ours. They are copied in byte for byte and
**must never be edited** — not to fix a typo, not to reformat, not to normalize
a line ending. `.gitattributes` marks both directories `-text` so a checkout
cannot normalize them either. The only correct edit is to re-vendor from a newer
release, and then the table below changes with them.

The directory exists because a DU submission has to validate against a chain that
does not assemble itself, and because two of the reasons it does not assemble
cost several hours each to find.

## What is here, and where it came from

The corpus lives outside this repository, at the path `DU_SPEC_DIR` names.
Everything below is relative to it.

### Whose these are

The rights are not ours either. Three holders, and only one of them says so in
the files:

- **MISMO's five.** `MISMODataTypesB324.xsd`, `MISMOEnumeratedTypesB324.xsd`,
  `MISMOExtensionDetailsB324.xsd`, `MISMO_3.4.0_B324.xsd` and
  `xlinkMISMOB324.xsd` each carry, in their own text, a notice reading
  `Copyright 2015 Mortgage Industry Standards Maintenance Organization (MISMO)`
  and pointing at the MISMO End User License Agreement. Read the notice in the
  file rather than a restatement of it here — a restatement goes stale and the
  file it describes cannot.
- **Fannie Mae's three, and every sample.** `DU_Wrapper_3.4.0_B324.xsd`, `DU_ExtensionV3_4.xsd`,
  `ULAD_ExtensionV3_4.xsd` and all eighteen documents in `samples/` carry no
  notice at all. They are Fannie Mae's, and the terms that cover them are the
  DU integration agreement's rather than anything written in the files.
- **The W3C's one.** `xml.xsd` is the W3C's schema for the XML namespace,
  redistributed inside MISMO's publication and vendored from there. It carries
  no notice either; it is the W3C's, under the W3C Software and Document
  License.

They are in the tree under a decision recorded here, because this file is the
only one in the tree that says whose they are: build as though the licenses and
the agency agreement are in place, on the understanding that no real borrower
and no real loan goes through this system until they actually are. Git keeps a
file forever once it lands, which is why that is written here rather than
carried in somebody's head.

### `xsd/` — nine files, flat

The chain is the **transitive closure of the DU wrapper's imports**, resolved by
following them outward, not by copying every file with an `.xsd` extension. The
corpus holds seventeen; nine are on the message path.

| File                            | Source path under the corpus                                                     |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `DU_Wrapper_3.4.0_B324.xsd`     | `DU Specs/Fannie Mae DU Schema Files updated 080825/`                            |
| `DU_ExtensionV3_4.xsd`          | `DU Specs/Fannie Mae DU Schema Files updated 080825/`                            |
| `ULAD_ExtensionV3_4.xsd`        | `DU Specs/Fannie Mae DU Schema Files updated 080825/`                            |
| `MISMO_3.4.0_B324.xsd`          | `Mismo/V3.4_B324_CR_2016-01-28_PUBLICATION/ReferenceModel_v3.4.0_B324/Combined/` |
| `xlinkMISMOB324.xsd`            | `Mismo/V3.4_B324_CR_2016-01-28_PUBLICATION/ReferenceModel_v3.4.0_B324/Combined/` |
| `xml.xsd`                       | `Mismo/V3.4_B324_CR_2016-01-28_PUBLICATION/ReferenceModel_v3.4.0_B324/Combined/` |
| `MISMODataTypesB324.xsd`        | `Mismo/V3.4_B324_CR_2016-01-28_PUBLICATION/ReferenceModel_v3.4.0_B324/`          |
| `MISMOEnumeratedTypesB324.xsd`  | `Mismo/V3.4_B324_CR_2016-01-28_PUBLICATION/ReferenceModel_v3.4.0_B324/`          |
| `MISMOExtensionDetailsB324.xsd` | `Mismo/V3.4_B324_CR_2016-01-28_PUBLICATION/ReferenceModel_v3.4.0_B324/`          |

**Two files with the same name come from different directories, and which one
you take matters.** `xlinkMISMOB324.xsd` exists in both the reference model root
(9,000 bytes) and in `Combined/` (16,101 bytes); the `Combined/` one is vendored
because that is the one the flattened model was published against. `xml.xsd` is
byte-identical in both.

Versions, as the files assert them:

- MISMO reference model **v3.4.0 B324**, publication `V3.4_B324_CR_2016-01-28`.
  Documents carry it as `MISMOReferenceModelIdentifier="3.4.032420160128"`.
- Fannie Mae DU schema files, **updated 08/08/25**. The wrapper's target
  namespace is MISMO's; the two extension namespaces are
  `http://www.datamodelextension.org/Schema/DU` and `…/Schema/ULAD`.

**Left behind deliberately**, and why, because "there were seventeen and you
took nine" is the first question a reader has:

- `ReferenceModel_v3.4.0_B324/MISMO_3.4.0_B324.xsd` (5,124 bytes), which declares
  no complex types at all and `xsd:include`s `MISMOComplexTypesB324.xsd` (3.2M),
  which in turn includes `MISMOComplexTypeExtensionsB324.xsd` (292K). This is the
  **split** packaging of the same 3,228 types the vendored `Combined/` build
  carries inline — an alternative, not an addition. See trap 2: the split build
  does not compile under the wrapper.
- `ReferenceModel_v3.4.0_B324/xlink.xsd` — the W3C original. MISMO's own
  `xlinkMISMOB324.xsd` is what every file in the chain actually imports.
- `ReferenceModel_v3.4.0_B324/xlinkMISMOB324.xsd` and `…/xml.xsd`, the split
  build's copies of two files vendored from `Combined/` instead.
- `LDDReport_v3.4.0.0_B324/LDDSchema-20140915.xsd` and its twin under
  `V3_4_B324_R_2016-01-28_LDD/`. The Logical Data Dictionary report schema
  describes the data dictionary, not the message. No document validates against
  it and nothing imports it.

### `samples/` — eighteen files

`DU Specs/DU Specification Test Case Suite June 2026/Updated XML Files/`, whole,
filenames unchanged. 712,093 bytes. They are Fannie's own conformance cases —
nine conventional, one HomeStyle, four FHA, four VA — and every one of them
carries `<AboutVersionIdentifier>DU Spec 1.9.x</AboutVersionIdentifier>` while
the workbook this repo generates against is 1.9.3. They are examples of the
shape, not of the current release.

## The assembly traps

Three, in the order somebody hits them.

**1. The Fannie directory alone does not compile, and it fails as a compile
error rather than a poor validation.** Pointing `xmllint` straight at
`…/Fannie Mae DU Schema Files updated 080825/DU_Wrapper_3.4.0_B324.xsd` gives
`Failed to load the document '…/MISMO_3.4.0_B324.xsd' for redefinition` and
`WXS schema … failed to compile`. That directory holds three of the nine files.
Assembling the other six is a prerequisite, not tidying.

**2. The split reference model does not compile either.** `DU_Wrapper` does an
`xsd:redefine` over fourteen `*_EXTENSION` types that, in the split build, live
inside an `xsd:include`d file — and libxml2 will not chase a redefine through an
include. Thirteen of the fourteen come back as
`The complex type definition '…' to be redefined could not be found in the
redefined schema`. Only the pre-flattened `Combined/` build works, which is why
that column of the table says `Combined/`.

**3. The `Combined/` build alone is still not enough.** `DU_ExtensionV3_4.xsd`
and `ULAD_ExtensionV3_4.xsd` import `MISMODataTypesB324.xsd` with **no
`namespace` attribute**, because that file declares no `targetNamespace` — it is
a chameleon schema, absorbed into MISMO's namespace when included and imported
as no-namespace here. So the three no-namespace files have to sit alongside the
flattened model, and they come from the reference model root rather than from
`Combined/`.

With all nine flat in one directory, every `schemaLocation` in the chain
resolves as a bare filename and it compiles:

```
xmllint --noout --schema src/infra/integrations/du-schema/xsd/DU_Wrapper_3.4.0_B324.xsd <file>
```

About 0.15s per document, nearly all of it spent compiling the 6.9M schema.

## What `xmllint` is worth here, stated plainly

**Almost nothing, and treating it as a gate is the mistake this README exists to
prevent.**

`xlink:label`, `xlink:from` and `xlink:to` are typed `xs:NCName` in
`xlinkMISMOB324.xsd` — **not `xs:ID` and `xs:IDREF`**. There is therefore no
referential integrity and no uniqueness anywhere in the relationship graph, and
the graph is the whole of how DU reads a submission. Measured against this
chain, all of the following **validate**:

- an `xlink:to` pointing at a label that exists nowhere in the document
- two containers carrying the same `xlink:label`
- an invented arcrole, and a mis-cased real one
- two sibling `ASSET` elements with the same `SequenceNumber`
- five borrowers, where the cap is four; twelve parties, where it is ten
- deleting every `<DECLARATION>` block, which the spec calls `1:1`
- deleting a required child — an `ASSET` with no `<AssetType>` in it
- deleting the entire `<RELATIONSHIPS>` container
- deleting a whole top-level container: the `<LOANS>` block, or every
  `<PARTY>`. A submission with nothing to underwrite and nobody to underwrite
  it validates against this chain.
- a 60-character `LoanIdentifier` where DU's limit is 15

Three kinds of mutation do fail, and each of them is a kind rather than a single
case — naming one case is how a harness comes to look smaller than it is:

- **an enumeration violation** — a value outside a MISMO enumeration
- **a sequence-model violation** — a child out of `xsd:sequence` order, an
  element name the model does not know, a singleton child repeated
- **a datatype or facet violation** — `False` where `false` was wanted, a
  non-numeric amount, a malformed `CreatedDatetime`, a `SequenceNumber` of
  zero, an `xlink:label` that is not an NCName

All of it is lexical and local to one element or one attribute, and none of it
is the graph. Two of the three are exactly what a serializer gets wrong, so the
harness is worth having — as a **lint**.

`schema.test.ts` here asserts both halves, line for line: the eighteen
samples validate, every mutation named above as caught is caught, and every
mutation named above as passing passes. The second group is there so that
nobody later promotes this to a gate by mistake, and both groups are exhaustive
against these lists so that the prose cannot drift from the validator without a
red test.

**Schema validity is necessary and nowhere near sufficient, which is why the
invariants live in our database.** Every arc is a foreign key, every cardinality
maximum is a CHECK or a trigger, and the reason is the same one that puts
`docs/ARCHITECTURE.md`'s append-only and balanced-ledger rules (conventions 3
and 4) in Postgres triggers rather than in service code: an invariant held by a
trigger survives a new route written by somebody who never read this file, and
an invariant held by application code does not. The gate on a submission is
23.7's preflight in `src/domain/underwriting/du`, not this.

## Using it

```ts
// from src/domain/underwriting/du; the helper is index.ts in this directory
import { samplePaths, xmllintErrors } from "../../../infra/integrations/du-schema/index.ts";

for (const path of samplePaths()) {
  const errors = xmllintErrors(path); // [] means it validated
}
```

`xmllintErrors` shells out to the system `xmllint` rather than adding an XML
schema validator to the dependency tree. There is no small one to add —
compiling 3,228 complex types is libxml2's job, and the JavaScript packages that
do it are native bindings to that same library or megabytes of their own — and
`xmllint` ships with macOS and with the Linux images this repo builds on
(`libxml2-utils` in the `Dockerfile` and in the CI job). If it is not on `PATH`
the function throws; it never reports success for a check that did not run.

## `tools/build-du.mjs` reads `xsd/` from here

Four of the nine files — the wrapper, the two extensions and the flattened MISMO
model — are what `src/domain/underwriting/du/generated/order.ts` is derived from. Because
they are vendored, `npm run du:verify` re-derives every child sequence from them
on any machine, with no `DU_SPEC_DIR` and no corpus. The workbook half of that
check still needs the corpus and still says so when it skips.

The workbook itself is **not** vendored, and the reason is not size — measured,
it is 728K, against 10.4M for the chain in this directory. It is that the
workbook is a document that moves: Fannie reissues it several times a year, and
git keeps every copy forever. The schema chain is the opposite — a frozen 2016
MISMO publication plus a dated Fannie release, and the thing that decides
whether an emitted document is legal.

That is a judgment rather than a rule, and the numbers are here so it can be
revisited. Vendoring the workbook would cost about 707K and would let
`du:verify` check the other four generated tables in CI as well.
