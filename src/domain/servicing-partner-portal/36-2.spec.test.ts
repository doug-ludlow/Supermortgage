// 36.2 Partner tape drop on book.import: the upload with its report, the import history, the status line and the holds
// spec/sections/36-servicing-partner-portal/36-2-partner-tape-drop-on-book-import.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("36.2-T1: Given the demo fixture tape + supplement and a partner_admin session for that partner, when they POST the files, then `importPartnerBook` writes the same 12 `monitored` loans 33.1-T1 already asserts, and the actor on `book.import` is the partner_user, not `ops_analyst`.", { todo: true });
test("36.2-T2: Given the same files posted a second time, then the response is `already_loaded` and no new `partner_book_facts` rows are written.", { todo: true });
test("36.2-T3: Given a later `as_of_date` tape that drops one loan, then that loan is `not_on_latest_tape` / on hold, it is absent from the next 33.2 review, and the partner GET holds lists it. `POST .../resolve` as the partner is `403`.", { todo: true });
test("36.2-T4: Given a partner_admin for partner A, when the multipart names partner B in a field, then that field is ignored and the import attaches to partner A.", { todo: true });
test("36.2-T5: Given a header that does not match `m3-v1`, then no rows are written and the partner sees the same header-refusal 33.1 already emits.", { todo: true });
