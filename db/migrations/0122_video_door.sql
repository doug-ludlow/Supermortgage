-- 0122_video_door.sql — 32.17 The video door (spec/sections/32-borrower-experience/32-17-the-video-agent-the-same-conversation-face-to-face.md, rules 11–13).
--   sessions.auth_method gains 'video': a session the video door opened on a provisional account — no code, no password, no Google —
--   before the borrower has said their name. It expires on the same idle rule as a code session (30 minutes; src/runtime/borrower/auth.ts
--   sessionExpiry). The account becomes reachable from another device once the e-mail Michelle asked for is on parties.contact
--   (video.identify) and a code to it opens a session (POST /v1/borrower/auth/otp, channel email).
-- Append-only: 0121 holds video_sessions; nothing there is edited.
BEGIN;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('otp_phone', 'otp_email', 'passkey', 'oidc_google', 'password', 'video'));
COMMENT ON COLUMN sessions.auth_method IS 'otp_phone | otp_email | passkey | oidc_google | password | video (32.17: the video door opened a provisional account; the name and e-mail follow through video.identify)';
COMMIT;
