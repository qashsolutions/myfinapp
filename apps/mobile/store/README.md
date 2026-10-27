# Store submission (chunk 2.5)

The listing texts, Apple privacy labels and Play Data safety answers below are written from the
app's real data flows (CLAUDE.md "Local-first"; docs/spec.md "Accessibility, privacy &
security") and are ready to paste into App Store Connect and the Play Console. They are drafts
until the owner signs them, like the legal pages.

What a human still does, in order:

1. Decide `[Name]` and `[domain]`; the app id `com.stackd.app` and every text below follow.
2. Create the apps in both consoles under `[Company legal name]`'s developer accounts.
3. Create the subscription products with the exact ids in `plans.yaml` `store_products`
   (`com.stackd.app.private.monthly` / `.yearly`, `com.stackd.app.connected.monthly` /
   `.yearly`), prices from `plans.yaml` (the consoles want local prices; USD is the anchor).
   No Founding product: it is web-only (no 4-year term in the stores).
4. Point App Store Server Notifications V2 at `https://api.[domain]/api/webhooks/apple` and
   Play RTDN's Pub/Sub push at `https://api.[domain]/api/webhooks/google`; put the Play
   service account in `STACKD_PLAY_SERVICE_ACCOUNT` and the APNs key in `STACKD_APNS_*`.
5. Export screenshots from `docs/design-handoff/previews/` at the required device sizes
   (6.9" and 6.5" iPhone, 13" iPad if offered, phone + 7" and 10" tablet on Play). Home,
   Money in & out, Goals, Budget, Next 30 days make the strongest five.
6. Review notes for Apple: the app signs in with an email code plus a passkey, so give the
   review team a dedicated test address on a mailbox `[owner]` controls, or a review build
   pointed at a staging API with a documented test account. (Open question for `[owner]`:
   the OTP-only review path.)
7. Fill the privacy labels / Data safety form from the answers below, attach the privacy
   policy URL (`https://[domain]/privacy`) and the deletion URL
   (`https://[domain]/delete-account`), and submit.

The chunk's other two "done when" conditions already hold in code: account deletion is two
taps in-app (Me → Delete) and public on the web (W.3), and the Plan screen shows price,
renewal terms and how to cancel before any purchase.
