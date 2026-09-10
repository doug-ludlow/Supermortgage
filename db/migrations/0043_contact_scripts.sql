-- 0043: §17.2 data model — `contact_scripts`: the versioned borrower-contact scripts the
-- `borrower-comms` agent runs during the post-transfer support window (version `transfer_out.v1`
-- for a transfer-out batch: "who do I pay", "where is my payment", "why did my draft stop", with
-- the AI disclosure, identity verification and a warm transfer to a human agent on request).
-- A script is active days 1–90 after `transfer_date` (SM_XFER_OUT_BORROWER_ROUTING_90, decision 3);
-- after day 90 calls are referred with the transferee's number only. Rows are append-only: a change
-- is a new version, never an update. No outbound calls or texts are generated from a script (TCPA).
BEGIN;

CREATE TABLE contact_scripts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                        text NOT NULL,                                     -- 'transfer_out'
  version                     text NOT NULL,                                     -- 'v1' → script version "transfer_out.v1"
  agent                       text NOT NULL DEFAULT 'borrower-comms',            -- agents.json id that runs it
  batch_id                    uuid REFERENCES transfer_batches(id),              -- the transfer-out batch it serves (null = generic)
  ai_system_version_id        uuid REFERENCES ai_system_versions(id),            -- the inventoried assistant version reading it (19.x)
  intents                     jsonb NOT NULL DEFAULT '["who_do_i_pay","where_is_my_payment","why_did_my_draft_stop"]',
  disclosure_text             text NOT NULL,                                     -- the AI assistant discloses automation (17.2 integrations)
  identity_verification       jsonb NOT NULL DEFAULT '{}',                       -- factors required before account details are read
  transferee_contact          jsonb,                                             -- {name, toll_free, hours, remittance_address} read to the borrower
  transferor_tollfree         text,                                              -- Supermortgage number staffed through the support window
  warm_transfer_role          text NOT NULL DEFAULT 'human_agent',               -- on request → human_agent (17.2 escalations)
  outbound_allowed            boolean NOT NULL DEFAULT false CHECK (outbound_allowed = false),  -- inbound only (TCPA)
  accepts_payments            boolean NOT NULL DEFAULT false CHECK (accepts_payments = false),  -- after T only as misdirected payments
  active_from                 date NOT NULL,                                     -- transfer_date + 1
  active_to                   date NOT NULL,                                     -- transfer_date + 90 (support window end)
  refer_only_text             text NOT NULL,                                     -- what is said after active_to: the transferee's number only
  status                      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'active', 'retired')),
  verified_by                 text,                                              -- SM_TOLLFREE_LIVE_GATE: toll-free/IVR scripts verified live
  verified_at                 timestamptz,
  created_by                  text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (active_to > active_from),
  UNIQUE (code, version, batch_id)
);
COMMENT ON TABLE contact_scripts IS '§17.2 data model: versioned borrower-comms scripts (transfer_out.v1) for the 90-day post-transfer support window — who-do-I-pay / where-is-my-payment / why-did-my-draft-stop with AI disclosure, identity verification and warm transfer; inbound only; append-only.';
COMMENT ON COLUMN contact_scripts.transferee_contact IS 'pii-adjacent business contact: transferee name, toll-free, hours, remittance address';
CREATE INDEX contact_scripts_batch_idx ON contact_scripts (batch_id, active_from, active_to);
CREATE INDEX contact_scripts_active_idx ON contact_scripts (code, status) WHERE status = 'active';

COMMIT;
