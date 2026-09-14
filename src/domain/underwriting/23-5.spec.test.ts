// 23.5 The relationship graph and the modeled set: what a DU submission is assembled from
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-5-the-relationship-graph-and-the-modeled-set.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("23.5-T1: Given a live `du_assets` row, when the transaction commits with no `du_asset_parties` row for it, then COMMIT is refused with `DU_GRAPH_ORPHAN` and no row exists afterwards.", { todo: true });
test("23.5-T2: Given an asset with two owner arcs, when one arc is deleted in a later transaction, then COMMIT succeeds; when the second is deleted, then COMMIT is refused.", { todo: true });
test("23.5-T3: Given an owned property and a liability secured by it with UPB $250,000.00, when a second liability of $40,000.00 is secured by the same property, then `du_owned_properties.lien_upb_cents` reads 29000000 with no caller having written it; when the first is retired, then it reads 4000000.", { todo: true });
test("23.5-T4: Given an owner arc whose asset is on application A and whose borrower is on application B, when written, then it is refused with `DU_GRAPH_CROSSES_APPLICATIONS`.", { todo: true });
test("23.5-T5: Given a borrower whose `du_declarations` row has `bankruptcy = Yes`, when the transaction commits with no `du_bankruptcy_filings` row, then COMMIT is refused; given the row has `bankruptcy = No`, when a filing is inserted, then COMMIT is refused.", { todo: true });
test("23.5-T6: Given a declarations write whose `asserted_by_actor` is an agent actor, then it is refused with `DU_DECLARATION_NOT_SELF_ATTESTED`; given it is another borrower's actor on the same application, then it is refused with the same code.", { todo: true });
test("23.5-T7: Given a borrower's written bankruptcy explanation submitted on the declarations card, when the row is read back, then `bankruptcy_explanation` holds it verbatim.", { todo: true });
test("23.5-T8: Given a borrower with a Prior residence and no Current one, when the transaction commits, then it is refused; given `residency_basis = Rent` and `monthly_rent_cents IS NULL`, then the CHECK refuses the row.", { todo: true });
test("23.5-T9: Given an application with Borrower 1, when three more borrowing parties are appended concurrently, then they receive ordinals 2, 3 and 4 with no duplicate; when a fifth is appended, then it is refused.", { todo: true });
test("23.5-T10: Given `applications.du_casefile_id` set to `1234567890`, when the same value is written again, then it is a no-op; when `0987654321` is written, then the update raises `DU_CASEFILE_ID_WRITE_ONCE`.", { todo: true });
test("23.5-T11: Given each of the 22 DU `AssetType` values, when written under a `kind` whose URLA section does not admit it, then the per-kind CHECK refuses the row; when written under the admitting kind, then it is accepted — and the three admitted lists partition the 22 with no overlap.", { todo: true });
test("23.5-T12: Given two borrowers linked by `du_joint_credit_report_links`, when a third is linked to the same primary, then the group has one primary; when a link is written whose `to_` borrower already belongs to another group, then it is refused.", { todo: true });
test("23.5-T13: Given a `du_owned_properties` row, when a caller writes `application_id` different from its asset's, then the trigger overwrites it with the asset's; when a caller writes `lien_upb_cents`, then the value is discarded and re-derived.", { todo: true });
test("23.5-T14: Given a borrowing party demoted to `non_borrowing_spouse` while sole owner of a live asset, then the role change is refused until the asset is repointed or retired.", { todo: true });
