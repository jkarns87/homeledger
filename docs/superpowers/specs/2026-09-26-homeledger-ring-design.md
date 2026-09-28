# HomeLedger: Ring pipeline design (Plan 4)

Status: approved design, 2026-09-26. **Supersedes §6 ("Ring pipeline") of [`2026-09-13-homeledger-design.md`](2026-09-13-homeledger-design.md).** Every other section of that spec stays in force. Where this document and that one disagree about Ring, this one wins.

Evidence base: [`docs/superpowers/research/2026-09-21-ring-partner-api.md`](../research/2026-09-21-ring-partner-api.md), cited below as *research §N*. Anything that research marks **Unverified** stays unverified here. The plan measures it; it does not assume it.

## 1. Goal and scope

A service visit booked through `book_service` becomes something the house notices. When the booked provider presses the doorbell, the visit is marked arrived. The simulator then shows a card with a doorbell snapshot and one sentence describing it. When the flood & freeze sensor trips, HomeLedger raises an alert and opens or advances a maintenance item.

In scope for v1:

- Ring account linking and token refresh.
- The signed webhook receiver.
- Device sync.
- Doorbell-to-visit correlation, with snapshot and description.
- Live sensor rules for the **Ring Sensors (Amazon Sidewalk) Flood & Freeze** sensor.
- Push to the simulator.

Out of scope for v1:

- **Contact sensors.** The rule exists but is exercised by fixtures only. The owner's contact sensors are Ring Alarm Z-Wave units, which the Partner API does not expose (research §5).
- Clips and live view.
- Multi-household linking.
- Hosting the simulator.

### What changed from the old §6, and why

| Old §6 | Now | Reason |
|---|---|---|
| Up to 10 linked accounts | 5, and only 1 used (single household) | research §7 |
| `sensor-rules` on `flood_detected` / `freeze_detected` / `contact_sensor_faulted` webhooks | A `SensorSource` port with **webhook** and **polling** adapters. A live test chooses between them (§6). | Those event names are not in Ring's documented list (research §2) |
| Snapshot described by Nova vision (Bedrock) | Described by **Claude vision via the Anthropic API** | Bedrock model invocation is blocked account-wide (FL-019, FL-032) |
| "Wait 5 s, then request a snapshot" | Retry with backoff for up to about 60 s, and record the latency actually observed | Image availability latency is undocumented (research §3) |
| "Verify TAKE is off before week 3" | TAKE must be **paused** for the whole demo and judging window, and checked twice | TAKE blocks all partner media and is becoming the default (research §4) |
| Staging support ticket on the critical path | No ticket. Authorise the account on the app's Test page. A Ring Protect plan or trial is still required. | Ring release note, 2026-09-11 (research §6) |
| Tokens and secrets stored by the link handler | Owner-managed Secrets Manager secrets, referenced by Terraform, never owned by it | Keeps secret values out of Terraform state. See §3. |

## 2. Architecture

A new package, `apps/events`, holds Lambdas for Node 22 on ARM64, bundled per function. It shares `packages/core` for domain types, the DynamoDB repository and the Ring client.

```
Ring ──POST /ring/link────▶ API GW (HTTP) ─▶ link Lambda ──▶ Secrets Manager (tokens), DEVICE# rows
Ring ──POST /ring/webhook─▶ API GW (HTTP) ─▶ ingest Lambda ─▶ EVENT# row ─▶ EventBridge bus "homeledger"
                                                                              │
                     ┌────────────────────────────────────────────────────────┼─────────────────────┐
                     ▼                                                        ▼                     ▼
             visit-correlator                                          device-sync           sensor-rules
       (button_press, motion_detected/human)                  (device_* events, nightly)   (SensorChanged)
                     │                                                                              ▲
                     ├─▶ Ring media API ─▶ S3 snapshots/ ─▶ Anthropic API (one sentence)            │
                     ▼                                                                              │
              push Lambda ─▶ API GW (WebSocket) ─▶ simulator server ─▶ SSE ─▶ browser    sensor-poller (Scheduler)
```

The infrastructure is Terraform in `infra/`, with plan and apply through GitHub Actions only, as for every earlier plan. It covers:

- an HTTP API and a WebSocket API
- a custom EventBridge bus with rules
- Lambdas, each with a dead-letter queue
- an EventBridge Scheduler for the poller and the token refresh
- an S3 prefix
- IAM roles, scoped per function

## 3. Account linking and secrets

**Secrets.** Owner-created in Secrets Manager (us-east-1). Terraform references them with `data` sources, so `terraform destroy` cannot delete them.

| Secret | Contents | Readers | Writers |
|---|---|---|---|
| `demo-homeledger/ring/client-secret` | OAuth client secret | link, token-refresh | owner |
| `demo-homeledger/ring/hmac-key` | HMAC signature key | ingest, link | owner |
| `demo-homeledger/ring/tokens` | Access and refresh tokens (JSON) | Every function that calls Ring | link, token-refresh |
| `demo-homeledger/anthropic/api-key` | Anthropic API key | visit-correlator | owner |

The **Client ID** is not a secret. It is a Terraform variable, like the Cognito client ID. IAM grants each function `GetSecretValue` on exactly the ARNs in its row.

**Linking.** Linking is Ring-driven:

1. The owner authorises the Ring account on the app's **Test** page.
2. Ring posts to `POST /ring/link`.
3. The link Lambda verifies the HMAC.
4. It exchanges the code at Ring's token endpoint.
5. It writes the tokens.
6. It calls `GET /v1/devices` to seed `DEVICE#` rows with their device class (doorbell or sensor kind).

v1 maps the one linked account to `hh_harlow` by configuration.

**Refresh.** An EventBridge Scheduler job refreshes tokens ahead of expiry, with the spec's 1-hour margin. The exact token lifetime is confirmed on the first link. A failed refresh writes an `ALERT#` row saying "Ring access lapsed". It is never silent.

## 4. Ingest (`POST /ring/webhook`)

The ingest Lambda does four things, in order, inside Ring's 5 s budget:

1. **Verify.** Check `X-Signature: sha256=<base64>` over the **raw request body bytes**, using a constant-time comparison. On failure it returns 401 and nothing else happens.
2. **Decode.** A total decoder reads the JSON:API envelope. A missing `sub_type`, an absent `component_ids` or an unknown `event_type` is recorded as data, never a crash.
3. **Dedupe.** It does a conditional put of `EVENT#<meta.request_id>`. A redelivery of an already *published* event gets 200 and is dropped.
4. **Publish.** It publishes to bus `homeledger` with `detail-type` set to the Ring event type, sets `published = true` on the row, then returns 200.

If publishing fails, it returns 500 so that Ring retries, and the unpublished row lets the retry through. Handlers get EventBridge retries plus a dead-letter queue. A dead-lettered event becomes an `ALERT#` row.

Documented event types (research §1):

- `motion_detected` (with `attributes.sub_type`)
- `button_press`
- `device_added`, `device_removed`, `device_online`, `device_offline`
- `app_integration_added`, `app_integration_removed`
- `subscription_activated`, `subscription_deactivated`

Unknown types are stored and routed nowhere.

## 5. Visit correlation and snapshot (`visit-correlator`)

**Trigger.** `button_press`, or `motion_detected` with `sub_type = human`, from a device whose `DEVICE#` class is `doorbell`.

**Match.** It looks for a visit with status `scheduled` whose window covers the event time ±30 min, using the existing visit index (`listVisitsInWindow`). If several match, it takes the one whose window start is nearest. If none match, it keeps the `EVENT#` row and pushes nothing.

**Arrive.** A conditional update moves the visit from `scheduled` to `arrived` and sets `arrivedAt`. Because the update is conditional, it is idempotent across a press and a motion event for the same arrival.

**Snapshot.** It calls `POST /v1/devices/{id}/media/image/download` with `latest_in_range` around the **webhook's timestamp**. That timestamp is after the owner's consent date, which avoids the 403 on earlier timestamps (research §3). It retries with backoff for up to about 60 s and records `snapshotLatencyMs`. The image is stored byte-for-byte under S3 `snapshots/` and is never cropped or re-encoded, so **Ring's mandatory watermark is preserved**.

The exact body fields and the redirect handling are Unverified (research §3). They are confirmed against the Playground or the first live call before the adapter is finalised.

**Outcome.** `snapshotStatus` is one of:

| Status | Meaning |
|---|---|
| `ok` | Image stored |
| `encrypted` | The device has TAKE on and the content is unreadable |
| `none-in-window` | No image in the requested window |
| `forbidden` | 403 |
| `error` | Anything else |

Every status maps to a plain sentence on the card. None renders as a blank.

**Description.** On `ok`, it sends one Anthropic Messages API call to `claude-sonnet-5` with the image and a constrained instruction: describe what is visible in one sentence, and never identify, name or guess who anyone is. The link to the booked provider comes from HomeLedger's matching, not from the image. The card says so, for example "Matches your 8–10 AM Kettle Creek visit". If the description fails, the card shows the image without a description.

**Changes to existing code.**

- The visit record gains `arrivedAt`, `snapshotKey`, `snapshotStatus`, `snapshotDescription` and `snapshotLatencyMs`.
- `get_visit` returns them, plus a presigned image URL valid for 10 min.
- The visit widget renders the photo and the sentence.
- The MCP server's role gains `s3:GetObject` on `snapshots/*` only.

**Push.** `visit.arrived` with the visit id.

## 6. Sensors (`sensor-rules`)

**Normalised input.** `SensorChanged { deviceId, kind: flood | freeze | contact, state: triggered | cleared, at, source: webhook | poll }`. It is emitted on **transitions only**.

**`SensorSource` port, two adapters.**

- **Webhook adapter.** It maps the event Ring actually sends for a sensor state change. The names come from a captured payload, not from the old spec.
- **Polling adapter.** An EventBridge Scheduler job, every 2 min by default and configurable, calls `GET /v1/devices/{id}/status` for sensor devices. It compares the result with the last-known state on the `DEVICE#` row and emits `SensorChanged` on a difference. A `429` backs off and is logged. The write-up states that alert latency is bounded by the interval.

**The deciding test (first live task).** Link the flood & freeze sensor, trip it (water, or cold), and observe both the webhook endpoint and the status endpoint. The result picks the adapter. **No sensor-specific code beyond the port is written before this test.**

**Rule table.** It lives in `packages/core` as pure functions and is tested exhaustively:

| Input | Alert | Maintenance |
|---|---|---|
| flood `triggered` | `ALERT#` severity high | Create or advance: "Check for a leak near <location>" |
| freeze `triggered` | `ALERT#` severity high | Create or advance: "Check pipe insulation near <location>" |
| contact `triggered` | `ALERT#` info (fixtures only in v1) | None |
| any `cleared` | Mark the open alert resolved | Leave open for a person to close |

**Flag.** `SENSORS_ENABLED` gates the live path independently of the doorbell path.

**Push.** `alert.raised` with the alert id. Alerts are also readable through `recent_events` and `maintenance_due`.

## 7. Push to the simulator

- **Transport.** An API Gateway WebSocket API with `$connect` and `$disconnect`. Connection rows are `CONN#<connectionId>` in the existing table, with a TTL.
- **Auth.** A Lambda authorizer on `$connect` validates the **Cognito client-credentials JWT** that the simulator server already fetches for MCP.
- **Who holds the socket.** The simulator's **Next.js server**, never the browser. The browser gets pushes through a new SSE route, `/api/agent/events`, behind the same origin and loopback checks as the other routes. No credential reaches client code (the Plan 3 guard).
- **Payload.** `{ cardType: "visit.arrived" | "alert.raised", id }`, a pointer only. The simulator runs an agent turn with an injected note naming the record, and the agent reads the details over MCP (`get_visit`, `recent_events`). The model narrates only what the server returned (FL-039).
- **Turn discipline.** A push that arrives mid-turn waits for the running turn to finish. Pushes that arrive while waiting are coalesced.
- **Reconnect.** Reconnects use backoff, and the connection status shows in the debug drawer. Missed pushes stay discoverable through `recent_events`.
- **Disclosure.** Push is the simulator's channel, not an MCP or Alexa+ capability. The on-screen disclosure names it.
- **Content rule.** Sensor cards describe property and maintenance. They make no life-safety claims and never reassure anyone that they are safe.

## 8. Testing and verification

The project's standing rule applies: an assertion counts only if a reasonable mutation of the code it guards makes it fail.

**Unit and integration tests.**

- **HMAC:** raw bytes against a re-serialised JSON body, a tampered body, the wrong key, a truncated signature.
- **Decoder:** every documented event, plus unknown and partial events.
- **Dedupe:** a redelivery, and a publish that failed and was then retried.
- **Correlation window:** the exact ±30 min edges, the household time zone, overlapping visits, a visit that is already `arrived`.
- **Snapshots:** each of the five snapshot outcomes against a fake Ring.
- **Rule table:** exhaustive.
- **Sensor adapters:** both, against a fake Ring, including a no-change poll and a `429`.
- **Authorizer:** a missing token and a bad token.
- **Push:** a push during a running turn waits.
- **Simulator:** push, then turn, then card.

**Fixtures.** Real payloads are captured from the Ring Developer Playground before the handlers are written (research §9). Invented fixtures are not accepted as the only evidence for a decoder.

**Terraform.** Native `terraform test` for the new modules.

**Smoke.** An extension posts a **signed synthetic webhook** to the deployed endpoint and asserts an `EVENT#` row plus EventBridge delivery. It needs no Ring access and runs on every deploy.

**Live checklist.** A new RUNBOOK section plus an FL entry, in the manner of FL-055:

1. Link the account and check the `DEVICE#` rows.
2. With a visit booked: press the doorbell. Expect the card, the photo, one sentence, and `snapshotLatencyMs` recorded.
3. With no visit booked: press the doorbell. Expect nothing pushed and an `EVENT#` row stored.
4. Trip the flood & freeze sensor. Expect the alert, the maintenance item and the card.
5. Check that TAKE is **paused**, before recording and before judging opens.

## 9. Owner prerequisites

- `aws login --profile homeledger-admin`, so the Ring secrets can be stored from the credentials file.
- Install the Battery Doorbell 4K Pro:
  - Ring Protect plan or trial active.
  - Video end-to-end encryption off.
  - TAKE paused. **Never "Reset Account Encryption".** It permanently removes access to encrypted video.
- Enable Amazon Sidewalk on the bridge.
- Add the Flood & Freeze sensor as a standalone Sidewalk device.
- Authorise the Ring account on the app's **Test** page.

## 10. Timeline (deadline 2026-10-23 12:00 PT)

| Window | Work |
|---|---|
| This week | Owner prerequisites (§9); Plan 4 written |
| To Oct 3 | Playground fixtures; ingest, bus and infrastructure deployed; linking live; sensor deciding test |
| To Oct 10 | visit-correlator, snapshot and description; `get_visit` and widget changes; live doorbell test with latency measured |
| To Oct 17 | Chosen sensor adapter and rules; WebSocket push and the simulator SSE route; end-to-end live run |
| Oct 18–22 | Buffer; live checklist; demo video; Devpost. **AWS credit form closes Oct 19.** |

## 11. Fallbacks, disclosed rather than hidden

- **TAKE cannot be paused.** Cards say the doorbell's encryption kept the photo private (`encrypted`). The arrival still registers.
- **The sensor never appears in the API.** The sensor half ships on fixtures only, and the write-up says so.
- **Anthropic vision is unavailable.** The card shows the photo without a sentence.
- **Webhooks are not delivered in staging.** The smoke test's synthetic webhook proves the pipeline. The live gap is recorded in its FL entry.

## 12. Amendment, 2026-09-27: what Ring's own documentation says

Ring's documentation became readable in full through Ring's public knowledge server (`https://knowledge.appstore-mcp.ring.amazon.dev/mcp`). Where it disagrees with sections 3–6 above, **this section wins**. Paths are Ring knowledge-base paths.

**12.1 Linking is two URLs, and the second is a sign-in page** (`amazon_vision_api/authentication/account_linking.md`, `amazon_vision_api/app_integrations.md`). Replaces §3 "Linking".

1. The owner authorises the account on the app's Test page.
2. Ring POSTs `code` (form-encoded) to the **Token Exchange URL**, `POST /ring/token`. The Lambda exchanges it at `https://oauth.ring.com/oauth/token` within 60 s (`grant_type=authorization_code`, `client_id`, `client_secret`), reads the Account ID from `GET /v1/users/me` → `data.id`, and writes the tokens to `demo-homeledger/ring/tokens` marked **unclaimed**.
3. Ring redirects the owner's browser to the **Account Link URL**, `GET /ring/link?nonce=…&time=…`. The page refuses a `time` older than 600 s and shows a sign-in form: one field, the household passphrase (`demo-homeledger/ring/link-passphrase`, owner-created). Ring makes a partner sign-in mandatory.
4. `POST /ring/link` checks the passphrase in constant time, recomputes the nonce as URL-safe Base64 (no padding) of `HMAC-SHA256(hmac_key_utf8, "<time>:<account_id>")` and compares in constant time, then calls `POST /v1/accounts/me/app-integrations {nonce, account_identifier}` and `PATCH … {status: "completed"}`. The PATCH is mandatory: without it Ring delivers no webhooks.
5. It marks the tokens **linked** and runs device sync.

Token lifetimes: access ~4 h (`expires_in: 14400`), refresh ~30 days; a refresh returns a new refresh token, which replaces the old one.

**12.2 Webhook signature is hex** (`amazon_vision_api/notifications.md`). Replaces §4 step 1's format: `X-Signature: sha256=<lowercase hex of HMAC-SHA256(hmac_key_utf8, raw body bytes)>`.

**12.3 The envelope** (`amazon_vision_api/notifications.md`, `…/notifications/motion_detection.md`). Replaces §4's field names: `meta.request_id` (idempotency), `meta.account_id`, `data.type` (the event type), `data.subType` (on motion: `motion`, `human`, `vehicle`, `other_motion`), `data.attributes.source` (device id when `source_type` is `devices`), `data.attributes.timestamp` (epoch **milliseconds**). Ring retries 5xx and timeouts at 1 s, 5 s, 30 s, 2 min, 10 min and 1 h, and **never retries a 4xx**. So verification failure answers 401 and a body with no `request_id` answers 400; everything transient answers 500.

**12.4 Sensor events are documented** (`amazon_vision_api/sensors/overview.md`, `…/sensors/flood_freeze_sensor.md`). Replaces §6's "deciding test". Flood & Freeze emits `flood_detected`, `flood_cleared`, `freeze_detected`, `freeze_cleared` (and `tamper_*`) in the same envelope. `GET /v1/devices/{id}/status` carries `flood_detection.faulted` and `freeze_detection.faulted`, independent booleans, and Ring says to treat status as the authority and reconcile against it. Both adapters therefore ship: the webhook adapter, and a reconciliation poll every `sensor_poll_minutes` (default 2). Both feed one transition detector keyed on the device's last-known state, so a trip alerts once. The live test becomes a confirmation test: it records which path saw the trip first.

**12.5 Snapshots** (`amazon_vision_api/image_download.md`). `POST /v1/devices/{id}/media/image/download` with `{type: "latest_in_range", start_timestamp, end_timestamp, image_options: {format: "jpeg"}}` (epoch ms) returns **303** with a presigned `Location`; a `GET` (no auth) returns the image. Outcome mapping:

| Ring answer | `snapshotStatus` | Retried? |
|---|---|---|
| 303, then 200 with JPEG or PNG bytes | `ok` | — |
| 303, then 200 with any other bytes | `encrypted` (Unverified: Ring does not document how TAKE content is marked) | no |
| 416 `MEDIA_NOT_FOUND`, 425 `RECORDING_NOT_READY` | `none-in-window` once the ~60 s budget is spent | yes |
| 403 (`TIME_RANGE_NOT_AUTHORIZED`, `REQUEST_FORBIDDEN`) | `forbidden` | no |
| 5xx, 503 `SERVER_BUSY`, network failure | `error` once the budget is spent | yes |
| anything else | `error` | no |

**12.6 Device kind is ours to record** (`amazon_vision_api/device_discovery.md`). `GET /v1/devices` returns only an id and the owner's name for it. A device whose status carries `flood_detection` or `freeze_detection` is recorded as a `sensor`; a device that sends `button_press` is recorded as a `doorbell`; otherwise `other`. A `button_press` always qualifies for correlation; `motion_detected` with `subType: human` qualifies only from a recorded doorbell.

**12.7 Unchanged:** the pipeline shape, the secrets principle, the ±30 min correlation rule, the five snapshot statuses, the rule table, push, testing, and fallbacks. The visit keeps its existing `description` field for the snapshot sentence rather than a new `snapshotDescription`, and gains `snapshotStatus` and `snapshotLatencyMs`.
