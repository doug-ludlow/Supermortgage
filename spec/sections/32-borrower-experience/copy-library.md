# Section 32 — copy library

<!-- docs/ux/12-message-copy-library.md (Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)), imported by tools/import_ux.py. Reference material for 32.13 (copy tests) and every 32.x copy key; the strings are not audit units. -->

Every string the borrower reads from the assistant or on a card is keyed here; the UI never hard-codes sentences. Regulatory **notices keep their template text** (Notice Registry) — this library holds the assistant's accompanying lines and card labels only. Tokens per 32.1 §7.4. Grade-8 reading level. Where a channel variant is not given, SMS uses the first sentence plus the deep link; e-mail uses the full text plus the CAN-SPAM footer when marketing.

Format: `key` — **card/message** — text — *notes*.

## Entry and identity

- `entry.disclosure.first` — system message — "I'm Supermortgage's automated assistant, working for {{partner.legal_name}}, your lender. You can reach a person at any time — just say *human*." — *first message of every session, every channel; voice reads it aloud.*
- `entry.disclosure.real_person` — reply — "No — I'm {{partner.legal_name}}'s automated assistant. I can bring a person in right now if you'd like." — *20.3 T11.*
- `entry.disclosure.co_admt` — line — "Colorado notice: an automated system helps evaluate your application. You have the right to an explanation, to correct information, and to a human review of a decision." — *before any pricing output; from Dec 1, 2026.*
- `entry.goal.question` — ChoiceCard title — "What are we doing today?" — options `Buy a home` · `Lower my rate or payment` · `Take cash out`.
- `entry.goal.contract` — ChoiceCard — "Do you have a signed purchase contract?" — options `Yes, I have a contract` · `Still looking`.
- `entry.occupancy` — ChoiceCard — "Will this be your primary home?" — options `Primary home` · `Second home` · `Investment property`.
- `entry.identify.why` — helper — "Your code keeps this conversation yours. We'll never text you marketing without asking first."
- `identity.stripe.purpose` — ConnectCard — "Verify your identity with a photo of your ID and a selfie. Takes about a minute." — what_we_get: "your name, date of birth and the address on your ID".
- `identity.confirm.title` — ConfirmCard — "Here's what your ID says. Right?"
- `identity.ssn.why` — ConfirmCard — "We need your Social Security number to pull your credit report. It's checked with the Social Security Administration and never shown again here."
- `identity.fallback` — StatusCard — "We'll take a closer look at your ID — nothing for you to do."

## Consents

- `consent.esign.title` — ConsentCard — "Get your documents electronically" — body: the E-SIGN statement (template `NTC_ESIGN_7001C_DISCLOSURE`) — footer: "Saying yes in chat or on a call doesn't count — check the box and type your name."
- `consent.esign.pending` — card state — "One more step: open the link we just e-mailed you and enter the code printed in the attached PDF. That proves your e-mail and PDF reader work."
- `consent.esign.active` — receipt — "E-delivery on. Documents will arrive here and by e-mail."
- `consent.esign.mail_instead` — StatusCard — "Until e-delivery is set up, we'll mail your documents to {{mailing_address}}."
- `consent.tcpa.title` — ConsentCard — "Calls and texts about your loan" — body from `consent_disclosure_versions` — footer: "Optional. Reply STOP to any text to end texts."
- `consent.tcpa.marketing.title` — ConsentCard — "Hear about refinance offers by call or text" — body: "Yes, {{partner.legal_name}} and Supermortgage on its behalf may call or text me at {{number}} using an automated system or an artificial or prerecorded voice about refinance offers. I understand consent is not a condition of any purchase or loan." — *exact PEWC text; 20.2.*
- `consent.credit.title` — ConsentCard — "Pull my credit report" — body from `credit_authorizations` template — helper: "This is a full credit check for your application."
- `consent.joint_intent.title` — ConsentCard — "Do you intend to apply for this loan jointly with {{other_first_name}}?"
- `consent.autodraft.title` — ConsentCard — "Set up autopay" — helper: "Optional — never a condition of your loan." — body: all 2.x rule-1 elements from the template.
- `consent.standing.title` — ConsentCard — "Keep my payroll and bank connections active so a future refinance takes minutes." — helper: "We only use them when you say yes to an offer. Turn off any time."

## Refinance and purchase intake

- `refi.home.confirm` — ConfirmCard — "Your home — right?" — fields: address · type · "your primary home".
- `refi.current_loan.confirm` — ConfirmCard — "Your current loan, from your credit report and county records. Correct?"
- `credit.liabilities.confirm` — ConfirmCard — "Your debts, from your credit report. Anything missing?"
- `credit.liabilities.student_zero` — helper — "For a student loan showing $0, the program counts 1% of the balance unless you have a statement showing your plan payment."
- `income.connect.purpose` — ConnectCard — "Connect your payroll so we can verify income without paystubs." — what_we_get: "employer, start date, pay frequency, base and variable pay, year-to-date" — fallback: "type your monthly income now; we'll ask for paystubs later".
- `income.confirm.title` — ConfirmCard — "Your income from {{employer}}. This becomes the income you're stating on your application."
- `income.other.question` — field — "Any other income you want considered? (Social Security, pension, child support, rental)" — default `None`.
- `profile.title` — ProfileCard — "A few things only you can tell us."
- `declarations.title` — ChoiceCard — "Does any of this apply to you?" — options `None of these apply to me` · `Something here applies`.
- `demographics.title` — DemographicsCard — the prescribed statement (App. B instruction 2) — options include `I do not wish to provide`.
- `value.confirm.title` — ConfirmCard — "Our estimate of your home's value is {{money}}. Use this, or enter your own?"
- `loan_amount.confirm.title` — ConfirmCard — "Loan amount: {{money}} — enough to pay off your current loan with no closing costs to you."
- `product.choice` — ChoiceCard — "Loan type" — options `30-year fixed` · `15-year fixed` · `Adjustable (ARM)`.
- `application.received` — StatusCard — "Application received {{date}}. Your Loan Estimate arrives by {{due}}."
- `du.running` — StatusCard — "Checking your application with the automated underwriting system — usually a couple of minutes. Nothing needed from you."
- `du.leave_ok` — StatusCard — "This is taking a bit longer. You'll get a message when it's done — no need to wait here."
- `terms.pending_mlo` — StatusCard — "Your terms and Loan Estimate are being reviewed by {{mlo.name}}, NMLSR ID {{mlo.nmlsr_id}} — expected by {{due}}."
- `decision.conditional_approval` — StatusCard — "Approved with conditions. {{count_you}} item(s) need you; we're handling {{count_us}}."
- `preapproval.intro` — StatusCard — "We'll get you a preapproval you can hand to a seller — based on verified income, assets and credit, run through the same underwriting system we use for the loan."
- `preapproval.letter` — DocumentCard — "Your preapproval letter" — why: "Good through {{valid_until}}. It's based on the property meeting the program's requirements."
- `preapproval.listing_numbers` — StatusCard — "{{address}}: taxes about {{money}}/yr, HOA {{money}}/mo, {{flood_status}}. Estimated payment {{money}}/mo with your {{down}} down."
- `preapproval.refresh` — StatusCard — "Your preapproval is good through {{date}}. Want us to refresh it? We'd re-check credit and income."
- `contract.upload` — UploadCard — "Send the signed purchase contract and any addenda."
- `contract.confirm` — ConfirmCard — "From your contract. Correct?"
- `insurance.select.choice` — ChoiceCard — "Homeowners insurance" — options `I have a quote or policy` · `Help me get quotes`.
- `insurance.requirement` — StatusCard — "Any policy works if it: covers replacement cost; has a deductible no more than 5% of coverage; is from a carrier rated AM Best B or better (or equivalent); names the mortgagee as: {{mortgagee_clause}}; and starts on or before {{disbursement_date}}."

## Disclosures, intent, lock

- `le.delivered` — DocumentCard — "Your Loan Estimate" — why: "This is the estimate of your loan terms and costs. Confirming receipt starts the timeline for your closing."
- `le.mailed` — StatusCard — "Mailed today to {{mailing_address}}. Want future documents electronically? Finish the e-delivery step."
- `le.costs_expire` — Dates label — "Estimated costs good through {{date}}".
- `le.what_changed` — block title — "What changed since your last estimate".
- `companion.hcl` — DocumentCard — "Housing counseling agencies near you" — why: "Federal rules require us to give you this list."
- `companion.toolkit` — DocumentCard — "Your Home Loan Toolkit" — why: "A guide to the process, from the CFPB."
- `companion.appraisal_notice` — DocumentCard — "Your right to a copy of the appraisal".
- `companion.score_notice` — DocumentCard — "Your credit score disclosure".
- `companion.arm` — DocumentCard — "How your adjustable rate works".
- `companion.privacy` — DocumentCard — "Privacy notice".
- `intent.title` — ChoiceCard — "Want to move forward?" — helper: "Until you say proceed, we can't charge anything except the credit report, or require documents. Proceeding lets us order title and start verification." — options `Proceed` · `Not yet`.
- `intent.too_early` — reply — "You'll be able to proceed once your Loan Estimate is in your hands — it's on its way."
- `intent.received` — StatusCard — "Thanks — we've ordered title and a flood determination and asked {{prior_servicer}} for your payoff figure."
- `lock.compare.title` — ComparisonCard — "Lock your rate?" — footnote: "Extensions cost {{cost_rule}}; if a lock expires before closing, the rate is set again when you relock."
- `lock.pending_mlo` — StatusCard — "{{mlo.name}} is confirming your lock — usually within 30 minutes."
- `lock.executed` — StatusCard — "Locked: {{rate}} through {{expires_at}}. An updated Loan Estimate follows within 3 business days."
- `lock.expiry_warn` — StatusCard — "Your lock expires {{date}}. If closing is later, we can extend — {{cost}} for {{days}} days."
- `lock.expired` — StatusCard — "Your lock expired {{date}}. Your loan can still close; the rate is set again when you relock."
- `revised_le.on_cd_instead` — StatusCard — "This change will show on your Closing Disclosure instead of a new Loan Estimate."

## Verification and conditions

- `needs.title` — ChecklistCard — "Needed from you".
- `needs.none` — Record state — "Nothing needed from you. We'll message you when something is."
- `needs.reminder` — message — "Still need {{count}} thing(s) from you for your loan — {{first_item}}. {{deep_link}}"
- `upload.mismatch` — card — "This looks like a {{detected}}; we need a {{expected}}."
- `upload.unreadable` — card — "We couldn't read this one — try a clearer photo or a PDF."
- `upload.stale` — card — "This one is dated {{date}}; we need one from the last {{n}} days."
- `explain.inquiry` — ExplanationCard — "Your credit report shows an inquiry from {{creditor}} on {{date}}. Did it result in a new account? If so, what's the payment?"
- `explain.deposit` — ExplanationCard — "A deposit of {{money}} on {{date}} into {{account_last4}} — where did it come from?"
- `new_debt.confirm` — ConfirmCard — "We see a new account with {{creditor}} opened {{date}}. Is this yours?"
- `coborrower.invite` — InviteCard — "Add {{first_name}} as a co-borrower. They'll get their own link and answer their own questions."
- `coborrower.waiting` — People — "{{first_name}} — invited, waiting".

## Decision, property, insurance, MI

- `decision.counteroffer` — ChoiceCard — "We can offer these terms instead" — options `Accept these terms` · `Decline` · `Talk to a person`.
- `decision.denial.next` — line — "You can request a copy of the appraisal (if one was done) and reach a person any time."
- `decision.noia` — StatusCard — "We need the items in this notice by {{date}} to keep your application open."
- `decision.withdraw.confirm` — ChoiceCard — "This ends your application. Your documents stay available to you." — options `Yes, withdraw` · `Keep going`.
- `valuation.value_acceptance` — StatusCard — "The automated underwriting system accepted your home's value — no appraisal, no fee."
- `valuation.schedule` — ScheduleCard — "Pick a time for the appraiser to visit (about an hour)."
- `valuation.copy` — DocumentCard — "Your appraisal" — footer link: "Ask for a value review".
- `valuation.low.choice` — ChoiceCard — "The appraised value is {{money}}, below {{price|requested}}. Options:" — options per 32.6 §2.
- `title.vesting.confirm` — ConfirmCard — "Title will be held by {{names}} as {{vesting}}. Right?"
- `insurance.deficient` — NoticeCard line — "One thing to fix: {{element}} — {{fix}}."
- `flood.notice` — DocumentCard — "Flood insurance is required for this property" — why: "The property is in a special flood hazard area."
- `mi.compare.title` — ComparisonCard — "Mortgage insurance options".
- `ctc.reached` — StatusCard — "Everything is verified. Next: your Closing Disclosure, then a signing appointment."
- `ctc.final_review` — StatusCard — "A final review is in progress — nothing needed from you."

## Closing, rescission, funding, boarding

- `cd.delivered` — DocumentCard — "Your Closing Disclosure" — why: "Confirming receipt starts the three-business-day wait before you can sign (Sundays and federal holidays don't count)."
- `cd.mailbox` — StatusCard — "Mailed {{date}}; it counts as received on {{date}} unless you confirm sooner."
- `cd.redisclosed_restart` — StatusCard — "This change restarts the three-day wait. Earliest closing is now {{date}}."
- `cd.wire_warning` — line — "Never send closing funds from instructions received by e-mail. Confirm by phone with your settlement agent first."
- `closing.schedule` — ScheduleCard — "Pick your signing time" — helper: "{{closing_type_sentence}} About 15–20 minutes. Have your ID ready."
- `closing.presign` — HandoffCard — "You can pre-sign the non-notarized documents now. The rest is signed live with the notary."
- `closing.failed` — StatusCard — "The session couldn't be completed. Let's pick a new time, or sign on paper with the settlement agent."
- `signed.refi` — StatusCard — "Signed. You have until midnight {{expires_at}} to cancel. Funding on {{date}}."
- `signed.purchase` — StatusCard — "Signed. Funds go out {{when}}."
- `rescission.how` — link — "How to cancel".
- `rescission.confirm` — ChoiceCard — "Cancelling ends this loan. Anything you paid is returned within 20 days." — options `Yes, cancel` · `Keep my loan`.
- `rescission.expired` — StatusCard — "Your cancel window ended. Funding is scheduled for {{date}}."
- `funding.progress` — StatusCard — "Funding is in progress — expected {{date}}."
- `funded.refi` — StatusCard — "Funded. {{prior_servicer}} is being paid off today; they refund your old escrow balance within 20 days — watch for it. Your first payment of {{money}} is due {{date}}."
- `funded.purchase` — StatusCard — "Funded. Ownership is being recorded; keys through your settlement agent. First payment {{money}} on {{date}}."
- `funded.no_skip` — line — "Interest from {{disbursement}} to {{month_end}} was collected at closing — no payment is skipped."
- `boarding.welcome` — StatusCard — "Welcome. You pay Supermortgage, servicing on behalf of {{partner.legal_name}}. Set up autopay and e-statements below."
- `boarding.fannie_letter` — HandoffCard — "Within about a month you'll get a letter from Fannie Mae saying it owns your loan. Nothing changes — you still pay Supermortgage."

## Servicing

- `payment.posted` — StatusCard — "Payment of {{money}} posted {{date}}: {{interest}} interest · {{principal}} principal · {{escrow}} escrow."
- `payment.held` — StatusCard — "Received {{money}}. Held until the remaining {{money}} arrives; if it doesn't within 30 days we'll return it."
- `payment.returned` — NoticeCard line — "Your bank returned the {{date}} payment. We'll try again on {{date}} unless you pay another way."
- `payment.due_soon` — message — "Payment of {{money}} due {{date}}."
- `late_charge.assessed` — StatusCard — "A late charge of {{money}} was added {{date}}."
- `autopay.next` — Loan — "Autopay {{money}} on {{date}} from ••••{{last4}}."
- `autopay.amount_change` — NoticeCard line — "Your autopay changes to {{money}} on {{date}}."
- `statement.available` — DocumentCard — "Your {{month}} statement".
- `escrow.paid` — StatusCard — "We paid {{payee}} {{money}} for {{line}}."
- `escrow.review_soon` — StatusCard — "Your yearly escrow review starts {{date}}."
- `escrow.shortage.choice` — ChoiceCard — "Your escrow is short {{money}}." — options `Spread over 12 months (+{{money}}/mo)` · `Pay {{money}} now`.
- `escrow.surplus` — StatusCard — "Escrow surplus of {{money}} — refund on its way."
- `insurance.renewal` — StatusCard — "Your homeowners policy renews {{date}}. If it renews automatically, nothing to do; if you switch carriers, send the new policy."
- `pmi.ending` — StatusCard — "Your mortgage insurance ends {{date}} — we'll remove it automatically."
- `pmi.cancel.choice` — ChoiceCard — "Ask to cancel PMI now?"
- `arm.change` — NoticeCard line — "Your rate changes {{date}}. Estimated new payment {{money}}."
- `hardship.open` — StatusCard — "If something's changed, tell me — there are options."
- `hardship.qrpc_summary` — ConfirmCard — "Here's what I understood: {{summary}}. Correct?"
- `hardship.protection` — line — "Because your complete application arrived more than 37 days before the sale date, the sale can't proceed while we review it."
- `hardship.offer.deadline` — line — "Please respond by {{date}}. If we don't hear from you, the offer is treated as declined."
- `hardship.tpp` — Loan — "Trial payment {{n}} of 3 — {{money}} due {{date}}."
- `hardship.forb` — Loan — "Payments paused through {{date}}."
- `team.assigned` — PersonCard — "Your team: {{team}}. Reach them directly at {{number}}."
- `case.ack` — line — "Logged as a formal request. You'll have an acknowledgment by {{date}} and an answer by {{date}}."
- `case.written_procedure` — line — "If you'd like a formal written answer, I've logged this as a request — here's how that works."
- `payoff.quote_live` — reply — "Today's payoff is about {{money}}. Want a written statement? It arrives within 7 business days."
- `successor.intro` — message — "I'm sorry for your loss. I can explain what's needed to confirm you as the person responsible for the home, without any pressure about payments."

## Rate-watch and re-refinance

- `ratewatch.block` — Loan — "Your rate {{rate}} · best available today {{rate}} · we'll tell you when a change is worth it."
- `ratewatch.worth_it` — helper — "Worth it means at least 0.25% lower with a real saving over seven years, at no cost to you."
- `offer.card` — OfferCard — structure per 32.11 §2 — options `Yes, let's do it` · `Not now` · `Never`.
- `offer.not_now` — reply — "We'll stay quiet about offers for 90 days. Ask any time."
- `offer.never` — reply — "Proactive offers are off. You can still ask about refinancing whenever you like; loan messages continue."
- `refi.same_servicer.funded` — StatusCard — "Done. Your new rate {{rate}} is live. Your old loan is paid off; your escrow balance moved over; your new payment is {{money}} starting {{date}}."

## Exits

- `payoff.funds_received` — StatusCard — "Payoff funds received {{date}} — {{money}}."
- `payoff.paid_in_full` — StatusCard — "Paid in full. Your escrow refund of {{money}} is on its way by {{date}}; the lien release records within {{n}} days."
- `transfer.goodbye` — StatusCard — "Your loan's servicing moves to {{new_servicer}} on {{date}}. Your terms don't change. Payments to us through {{date}}; after that, to them — anything sent to us in the following 60 days is forwarded and counts as on time."
- `closed` — StatusCard — "Your loan is closed. Your documents stay here."

## Channel variants (rules)

- **SMS**: first sentence + deep link; never a number the borrower hasn't seen in-app first (no rates, balances or payoff figures by SMS); STOP footer on the first message of a thread.
- **E-mail**: full text; subject = the card title; marketing e-mails carry the CAN-SPAM footer and the `partner` postal address.
- **Voice**: the same text spoken; cards described and sent as links; consents never taken by voice (`consent.esign.title` footer is read aloud).
- **Mail**: templates only.
