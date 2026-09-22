# Ring Partner API — current state, for a Plan 4 that does not exist yet

**Date:** 2026-09-21
**Status:** Findings only. No plan, no tasks, no implementation.
**Why now:** Ring developer registration is started and the Battery Doorbell Pro has arrived. This establishes what a Plan 4 would actually face, so that when access clears the plan can be written in an afternoon instead of researched in one.
**Method:** Public documentation and the Amazon Developer Community, read on 2026-09-21. **No Ring API call was made from here.** Every claim carries a verification level and a URL.

## How to read the verification levels

Three levels, and they are not decoration — a confident wrong answer in this document puts wrong tasks in Plan 4, and this project has already paid twice for a plausible inference presented as a fact (FL-038's proxy reasoning, FL-039's first diagnosis).

| Level | Means |
|---|---|
| **Verified** | Stated in Ring's own documentation or by Ring staff on Amazon's developer community, quoted below with its URL. |
| **Corroborated** | Consistent across two or more independent sources, at least one of them Ring's, but not stated outright in one place. |
| **Unverified** | Could not be read. Either the documentation page did not render the section, or the claim came from an unofficial source. **Treat as unknown, not as probably-true.** Section 10 lists every one of these in one place. |

A note on what went wrong while reading: `developer.amazon.com/docs/ring/api-documentation.html` is one very long page, and every fetch of it truncated before the Sensors, Image Snapshots, Event History and Retry Logic sections. Their headings are in the table of contents; their bodies were not readable. That is the single largest gap in this document and the reason section 10 is as long as it is.

---

## 1. The API in one page

**Verified unless marked.**

| | |
|---|---|
| Base URL | `https://api.amazonvision.com` — "The **Ring API** is the REST API hosted at https://api.amazonvision.com that partners use to access Ring devices." ([get-started](https://developer.amazon.com/docs/ring/get-started.html)); the same host appears in Amazon's own sample app ([AmazonAppDev/ring-api-helloworld](https://github.com/AmazonAppDev/ring-api-helloworld)) |
| Style | JSON:API |
| Rate limit | 100 requests per second per partner; `429` with `Retry-After` ([api-documentation](https://developer.amazon.com/docs/ring/api-documentation.html)) |
| GA date | 2026-04-21 for the Partner API as a whole: OAuth 2.0, device discovery, capabilities, status, configurations, locations, the webhook event set, live video (WHEP/RTSP), media clips, image snapshots, event history, subscriptions query ([release-notes](https://developer.amazon.com/docs/ring/release-notes.html)) |

### Endpoints confirmed by two sources

Each of these appears both in the API documentation's contents and in Amazon's official sample app:

- `GET /v1/devices` — devices the linked account has granted
- `GET /v1/devices/{device_id}/status` — online/offline
- `GET /v1/devices/{device_id}/capabilities` — video codecs, motion detection, image enhancements, camera modules
- `GET /v1/devices/{device_id}/location` — coarse only (country/state)
- `GET /v1/devices/{device_id}/configurations` — motion zones, privacy zones
- `GET /v1/history/devices/{device_id}/events` — past motion, doorbell and live-view events
- `GET /v1/users/me` — the linked account
- `POST /v1/devices/{device_id}/media/streaming/whep/sessions` — WebRTC live video
- `POST /v1/devices/{device_id}/media/video/download` — historical clips
- `POST /v1/devices/{device_id}/media/image/download` — snapshots (JPEG/PNG)
- `POST /v1/devices/{device_id}/media/audio/playback` — chime audio
- `POST` then `PATCH /v1/accounts/me/app-integrations` — account linking
- `DELETE /v1/accounts/me/app-integrations` — unlink, partner-initiated OAuth apps only (2026-09-15); one-way-linking apps get `403 Forbidden`

### Authentication

Two linking flows, and which one a partner gets is not a free choice.

**One-way (Ring-driven).** Ring releases credentials up front and redirects the user to the partner, with an HMAC-based nonce for cryptographic verification. The partner calls `POST /v1/accounts/me/app-integrations` with the nonce, then `PATCH` to finalise. This is the flow HomeLedger's spec §6.1 describes.

**Partner-initiated OAuth 2.0.** Standard authorization-code flow with PKCE (`S256`). Documented 2026-08-13 and **"available by invitation only."**

| Credential | Lifetime |
|---|---|
| Access token | ~4 hours (14,400 s) |
| Refresh token | ~30 days |
| Authorization code | 60 s (one-way) or 10 minutes (partner-initiated) |
| Developers Playground token | 30 minutes |

Expired refresh tokens require the user to re-link. Partners are told to refresh proactively.

**Scopes.** The documentation extraction returned `"ava"` and `"ava.v1:read"`, with partner-initiated OAuth currently supporting `ava.v1:read`. **Low confidence** — this came from a single extraction of a page that truncated elsewhere, and it is a string Plan 4 would hard-code. Re-read before using it.

Separately and more usefully, **dynamic scopes** (Early Access, 2026-08-24) let an app select which families it asks for: **Cameras and Doorbells** (motion events, doorbell presses, livestream, video download), **Sensors** (contact, flood/freeze, temperature/humidity, air quality — individually selectable), and **Chimes**. A fourth group, **Account and Lifecycle**, is always available and needs no configuration ([configure](https://developer.amazon.com/docs/ring/configure.html)).

### Webhooks

Ring POSTs signed notifications to one partner-configured URL. There is **no webhook subscription API** — the URL and the HMAC signing key are set in the Developer Portal during the Configure phase, alongside the Account Link URL and the Token Exchange URL.

Envelope (JSON:API):

```json
{
  "data": {
    "type": "event",
    "id": "<request_id>",
    "attributes": {
      "event_type": "<type>",
      "timestamp": "<ISO8601>",
      "device_id": "<id>",
      "account_id": "<id>",
      "component_ids": [],
      "sub_type": "<sub_type>"
    }
  },
  "meta": { "request_id": "<request_id>", "time": "<ISO8601>" }
}
```

- Signature: `X-Signature: sha256=<base64_value>`, HMAC-SHA256 over the raw request body bytes, keyed by the app's HMAC signing key. The docs call for constant-time comparison.
- The endpoint must "accept HTTPS POST requests, return HTTP 200 within 5 seconds, and implement idempotency using the `request_id` field" ([develop](https://developer.amazon.com/docs/ring/develop.html)).
- Retry/backoff behaviour on a non-200: **Unverified** — "Retry Logic" is a heading in the contents and its body did not render.

### The documented event types, in full

```
motion_detected      (carries attributes.sub_type, e.g. "human")
button_press
device_added
device_removed
device_online
device_offline
app_integration_added
app_integration_removed
subscription_activated
subscription_deactivated
```

That list is stable across the GA release note, the API documentation, the Configure page's webhook events, and the Develop page. **Read what is not in it.**

---

## 2. The finding that most changes Plan 4: there are no documented sensor events

**Verified in the negative; the positive mechanism is Unverified.**

HomeLedger's spec §6.3 builds a `sensor-rules` handler on `flood_detected`, `freeze_detected`, and `contact_sensor_faulted` webhook events. **None of those three strings appears anywhere in Ring's documented event list**, in four separate places that enumerate it. Nor does any other sensor-shaped event.

What the sensors documentation *does* say, from the 2026-08-24 release note: sensors are **"documented as a device family; sensors are `devices` resources with existing endpoints."** That sentence points at reading state through `GET /v1/devices/{id}/status` — polling — rather than at receiving it.

So the shape of the sensor integration is an open question with two candidate answers and real consequences either way:

- **If sensor state is read by polling**, spec §6.3's event-driven `sensor-rules` design does not fit. There is no webhook to verify, no EventBridge `detail-type` to route on, and the "flood detected" moment is discovered on a schedule rather than pushed. A freeze alert that is up to a polling interval late is a different product from one that arrives in seconds, and it changes the demo.
- **If sensor events exist but are undocumented on the page that would not render**, the spec's design is broadly right and only the event names need correcting.

**This is the first thing to resolve when access clears, and it is cheap to resolve:** link one sensor to the staging app, fault it, and watch the webhook endpoint. One afternoon settles the architecture of an entire plan. Do not write the sensor tasks before that.

A weak corroborating signal, and it is weak: an unofficial emulator built against this API during the same hackathon ([ring-sandbox](https://github.com/josepha-mayo/ring-sandbox)) models sensors with **`faulted` semantics** and a battery sentinel of `255` on mains-powered devices, and its README says "Sensors and chimes are Early Access upstream and may change" and that no sensor exists in the Playground to test against. `faulted` is a state noun, not an event name, which leans toward the polling reading. It is unofficial and should not be cited in a plan as anything but a hint.

---

## 3. Snapshots: confirmed to come from recordings only, with a ±10 second tolerance

**Verified, by Ring staff, on the record.**

Asked directly how to obtain a camera snapshot, Ring's Alex_boyd answered on the Amazon Developer Community ([thread 28387](https://community.amazondeveloper.com/t/obtaining-a-camera-snapshot/28387)):

> "This endpoint retrieves existing images only, it does not trigger a new capture."

and

> "Images are available when the device was recording (during a motion event or live session)."

That confirms the spec's constraint table and FL-013. The quantification the research brief asked for:

- **The API returns the most recent available image within a requested time window, with a ±10 second tolerance.** That is the only latency number Ring has put in writing, and it is a *search window*, not a delay — it says how far either side of your timestamp the service will look, not how long after an event an image exists.
- **There is no documented number for how long after a `button_press` an image becomes retrievable.** The spec's §6.3 design — "set arrived, wait 5 s, request a snapshot with `latest_in_range` around `at`" — is a guess at that number. It may well be a good one; it is not a documented one. **Unverified, and worth measuring on the real doorbell in the first week of access**, because the whole "your plumber is at the door" moment sits on it.
- **A hard failure mode with a non-obvious cause:** the `start_timestamp` must fall **after the user's consent date**. On a freshly linked account, requests for older snapshots return **403**. Ring's recommended workflow is to drive image downloads from webhook timestamps (which are post-consent by construction) or from Event History, rather than from a timestamp the app chose.

The request shape is `POST /v1/devices/{device_id}/media/image/download` with a `type` of `latest_in_range` plus timestamps taken from Event History. The exact body field names, the `303 See Other` redirect to a presigned URL, and that URL's expiry are **Unverified** — the Image Snapshots section did not render. The 303 redirect is described by the unofficial emulator, not by Ring.

**Every piece of media carries a mandatory watermark** since 2026-06-08: Ring logo, Device ID, App Name, and timestamp, on live streaming, clip downloads and image snapshots alike. Preserving it is not optional and the spec already says so.

---

## 4. TAKE and E2EE: the constraint that got worse, not better

**Verified, and this is the finding most likely to break the demo.**

FL-014 recorded that TAKE's effect on the Partner API was undocumented. It is documented now, and it is materially worse than "verify the setting is off."

From the 2026-09-16 release note and the Developer FAQ ([developer-faq](https://developer.amazon.com/docs/ring/developer-faq.html)):

- "Ring is rolling out two video-encryption modes: Throw Away the Key (TAKE) and End-to-End Encryption (E2EE)."
- On a **TAKE** device: it stays visible in the API, but "video requests return encrypted content, so your app cannot read recordings or snapshots, or open a live stream."
- On an **E2EE** device: "E2EE devices are not returned by any Ring Partner API, as users can't grant partner apps access to E2EE devices."
- Ring says it is "working to enable partner apps to process the most recent 24 hours of a TAKE device's video" — a future capability, not a current one.
- Reassuringly for the code: "Do I need to change my API integration? **No.**" Endpoint paths, authentication and schemas are unchanged. The device simply returns content the app cannot read.

The wider rollout context, from Ring's own and mainstream coverage: TAKE was announced 2026-08-26 as a new encryption standard that becomes **the default for cloud features**, rolling out in phases from September 2026, and Ring's consumer support article lists **"Third-Party App Integrations"** among the features that **require a temporary pause in TAKE** ([Using TAKE](https://ring.com/gb/en/support/articles/m508l/Using-TAKE-Throw-Away-the-Key-Encryption)).

**The tension, stated rather than resolved.** Press coverage and the release note describe TAKE as becoming the worldwide default; the consumer support article describes an opt-in enrolment ("Let's turn on TAKE") that arrives when an account becomes eligible. Both can be true at different points in a phased rollout. **Whether the Battery Doorbell Pro on this account will have TAKE on by demo time is Unverified**, and it is not a thing to find out in November.

**What this means concretely for Plan 4:** the snapshot-at-the-door moment — the centrepiece of the Ring track — requires TAKE to be off or paused on the demo doorbell for the whole demo and judging window (2026-11-09 to 2026-11-20). Pausing is reversible and keeps the setup intact; a full **"Reset Account Encryption" permanently removes access to all previously encrypted videos and cannot be undone**, so it is not the lever to reach for. Check the device's state early, write down how to pause it, and re-check before recording and before judging opens.

---

## 5. Sensors: the Partner API family is the Sidewalk line, not Ring Alarm's Z-Wave line

**Corroborated. The Partner API documentation does not use the word "Sidewalk", so the mapping is by product naming rather than by statement — but the match is exact in one direction and impossible in the other.**

The Partner API's sensor family, per the API documentation's contents and the Configure page's Sensors scope group, is four products:

1. Contact Sensors
2. Flood/Freeze Sensor
3. Indoor Temperature/Humidity Sensor
4. Indoor Air Quality Monitor

Ring's **Amazon Sidewalk compatible devices** support article lists the Ring Sensors line as: "Window and Door Sensor", "Motion Detector", "Flood and Freeze Sensor", "Temp and Humidity Sensor", "Air Quality Monitor", "Glass Break Sensor", "Sump Pump Monitor", all reaching the cloud through a Sidewalk bridge such as the Ring Bridge (2nd Gen) or a compatible Echo ([b4lyi](https://ring.com/support/articles/b4lyi/Amazon-Sidewalk-Compatible-Devices)).

The API's four are a strict subset of those seven. **Two of the four — the temperature/humidity sensor and the air quality monitor — have no counterpart in the Ring Alarm Z-Wave line at all.** Ring Alarm's sensor catalogue is contact sensors, motion detectors, flood & freeze sensors, glass break, and range extenders, all paired to a Base Station over Z-Wave; there is no Ring Alarm air quality monitor. So the Partner API's family cannot be the Z-Wave line, and it matches the Sidewalk line item for item as far as it goes.

**The consequence, and it is a hardware purchase.** The spec's timeline (§11, Sep 13–15) says "order doorbell, two 2nd-gen contact sensors, one 2nd-gen flood/freeze." "2nd gen" is Ring Alarm naming — the **Ring Alarm Contact Sensor (2nd Gen)** and the Ring Alarm Flood & Freeze Sensor are Z-Wave devices that require a Base Station. The devices the Partner API describes are the Sidewalk **Ring Sensors** line: a Window & Door Sensor at $29.99 that needs no hub or base station, only a Sidewalk bridge (which any Ring camera, Echo, or Ring Alarm hub provides).

If sensors have already been ordered against the spec's wording, check what arrived before spending a day on why the API cannot see them. **Unverified:** whether the Partner API returns Ring Alarm Z-Wave sensors at all. The naming strongly suggests not; nothing says so outright.

---

## 6. The staging trial ticket: probably already gone

**Verified that the rule changed. Unverified whether the specific blocker is cleared for this account.**

FL-012 records the gap, and the community thread it cites is still the clearest account of it ([thread 28731](https://community.amazondeveloper.com/t/issue-testing-staging-app-with-motion-events/28731)). A developer's staging app received `device_added`/`device_removed` but never `motion_detected`. After the obvious checks were exhausted, Ring's Eldar Ibrahimov identified the cause on 2026-07-13: the staging user had no per-app subscription, `GET /v1/accounts/me/subscriptions` returned empty, and device calls returned 403. His words:

> "There isn't a self-service screen in the Developer Portal to configure subscription tiers for staging. This is a known gap in the testing experience."

with the instruction to "open a support ticket through the Developer Portal and request that a trial subscription be manually provisioned for your staging user's account." The thread contains no follow-up confirming it worked.

**That gap appears to have been closed on 2026-09-11**, ten days before this was written. The release note reads: **"Staging users no longer go through a purchase or subscription activation step to test the staging version of your app,"** with the summary that "Authorizing an account on the **Test** page is all it takes to start testing."

Two caveats, both material:

1. **A Ring Protection plan is still required on the staging user's own account.** The FAQ is explicit that both staging and production accounts need "an active Ring Protection plan or trial on their own Ring account, because that plan activates the cloud features on the Ring devices." What went away is the *per-app* subscription step, not the *per-account* plan. A new doorbell ships with a trial, so this is usually satisfied by accident — but a lapsed trial in November would look exactly like the bug above.
2. **Approval times.** No published SLA for developer registration or identity verification; **Unverified**. The only published review number is for *certification of public apps*: "On average, 90% of submissions are reviewed in less than 48 hours" ([certify](https://developer.amazon.com/docs/ring/certify.html)) — and a **private app does not go through certification at all**, so it does not apply here.

**So the working assumption for planning: no ticket is needed, testing starts as soon as an account is authorised on the Test page, and FL-012 should be re-read and updated rather than treated as live.** Verify by authorising the account and watching for a `motion_detected` before building anything that depends on it.

---

## 7. Private apps allow five accounts, not ten

**Verified, and the spec is wrong.**

Spec §6.1 says "Private Ring app (up to 10 linked accounts, no certification)." The certification half is right — private apps "bypass certification and Appstore listing" ([configure](https://developer.amazon.com/docs/ring/configure.html), "Create a private integration exclusively for personal use or testing"). The count is not. The 2026-07-21 release note reads, verbatim:

> "Private apps bypass certification and Appstore listing, support up to 5 allowlisted Ring accounts,"

**Ten is a different limit:** the Develop guide says "Test with up to 10 staging users" and "Maximum 10 staging users allowed." Two numbers, two environments, and the spec merged them. For a one-household demo neither limit binds, so this changes nothing about what gets built — but it is the kind of number that ends up in a README, and a README that says ten would be wrong.

Creating an app at all requires a developer account plus completed identity verification: "Amazon requires all developer accounts to complete identity verification before you can create or submit applications."

---

## 8. Two things that did not exist when the spec was written

**Both Verified, both worth knowing before Plan 4 is written.**

**The Developers Playground** (released 2026-05-28) is a sandbox for the device, media and account APIs that needs no app, no account linking, and no active subscription. It gives one-click OAuth tokens valid 30 minutes, an interactive API explorer with curl commands and live JSON, and **live-view event simulation for Package, Vehicle and Motion event types** with a full WHEP session workflow. The spec already planned to use it, and it is better than the spec assumed: the no-app, no-linking part means event shapes and the JSON:API envelope can be pinned down before the account-linking flow is written at all.

Two limits worth writing down: a Playground token cannot reach a `localhost` webhook, so **webhook delivery cannot be exercised there** — an independent hackathon project hit exactly this ([attest](https://github.com/josepha-mayo/attest), which records "webhook delivery (a Playground token cannot reach a localhost URL)" as unverified for the same reason). And there is **no sensor in the Playground**, so the section 2 question cannot be answered there either.

**The Ring Appstore MCP Server** (documented at [ring-mcp](https://developer.amazon.com/docs/ring/ring-mcp.html)) is "a remote Model Context Protocol server backed by an Amazon Bedrock Knowledge Base," at `https://knowledge.appstore-mcp.ring.amazon.dev/mcp`, over streamable HTTP, exposing two tools: `search_docs` and `get_doc`. It indexes the Ring documentation and is aimed at developers building Ring apps.

Two reasons that is interesting here beyond convenience. It is very likely the route to the four documentation sections this research could not read — **the next person to pick this up should try it first**, since `get_doc` returns full documents where an HTML fetch truncated. And it is a Ring-operated MCP server in a hackathon whose primary track is MCP; that is worth a line in the submission write-up regardless of what Plan 4 does.

---

## 9. What can be built and tested before access clears

Quite a lot, and the shape is the one this repository already uses: a port with two adapters, the real one unexercised and the fixture one carrying every test. `packages/core`'s `ManualRetriever` is the working precedent — it has a Bedrock adapter that has never made a successful live call and a fixture adapter that the whole suite runs on, and that is why the account-wide Bedrock block (FL-019) cost development speed rather than stopping it.

**Buildable now, with no Ring access at all:**

1. **HMAC-SHA256 webhook verification.** The header format (`X-Signature: sha256=<base64>`), the bytes signed (the raw body), and the constant-time comparison are all documented. Testable exhaustively against synthesised bodies and a known key, including the negative cases that matter: a tampered body, a truncated signature, a correct signature under the wrong key, and a body re-serialised by a JSON round trip (which is the bug that gets written, because it verifies in every test that builds the body from an object).
2. **The JSON:API envelope decoder.** The shape in section 1 is documented. A total decoder over it — one that treats a missing `sub_type`, an absent `component_ids`, and an unknown `event_type` as data rather than as a crash — is exactly the `readToolResult` discipline from Plan 2 applied to a new wire, and it is the thing that will be handed a payload shaped slightly differently from the documentation.
3. **Idempotency on `meta.request_id`.** Documented, and it maps onto the conditional put on `eventId` the spec's §6.2 already describes. Testable against a duplicate delivery, which is a thing that will happen: a handler that took longer than 5 s gets its event again.
4. **The correlation window.** Spec §6.3's "a `scheduled` visit whose window covers `at ± 30 min`" is pure logic over `VISIT#` rows that `book_service` already writes and `listVisitsInWindow` already queries. It needs no Ring at all and it is where the demo's cleverness actually lives.
5. **The sensor rule table**, as a table. Whether the input arrives by webhook or by polling (section 2), the mapping from "flood detected on device X" to an `ALERT#` row and an advanced `MAINT#` item is the same function.
6. **A `RingMedia` port with a fixture adapter.** `{ latestImageInRange(deviceId, at): Promise<Bytes | null> }` is enough surface for the correlator to be written and tested end to end, with the fixture returning a canned JPEG, `null`, and a throw. The real adapter is one function and can wait.
7. **A fixture library, from the Playground rather than from imagination.** This is the highest-value pre-access task and it is available today: the Playground needs no app and no linking, so real `motion_detected` and live-view payloads can be captured now and replayed by a harness. Fixtures invented from a documentation table are fixtures that agree with the documentation and not with the service.

**Not buildable before access, and worth being honest about which:** anything that depends on the sensor delivery mechanism (section 2); the actual delay between a button press and a retrievable image (section 3); whether the Battery Doorbell Pro's TAKE state permits media at all (section 4); the one-way account-linking handshake end to end, since it begins with Ring posting to a public URL; and webhook delivery itself, which the Playground cannot reach.

---

## 10. Everything marked unverified, in one place

Nothing below should appear in Plan 4 as a fact, and each names how to settle it.

| # | Unknown | How to settle it |
|---|---|---|
| 1 | **Whether sensors emit webhook events at all, and under what `event_type` names.** The documented list has none; the Sensors section body did not render. | `get_doc` on the Sensors section through Ring's own MCP server, then confirm by faulting a real sensor against the staging app. |
| 2 | The sensor `devices` resource attribute names (`faulted`, battery, temperature, humidity, AQI) and whether state is polled. | Same. The unofficial emulator's `faulted` + `255` battery sentinel is a hint only. |
| 3 | The `media/image/download` request body fields, the `303` redirect to a presigned URL, and that URL's expiry. | Image Snapshots section; then one Playground call. |
| 4 | **How long after a `button_press` an image becomes retrievable.** The ±10 s figure is a search tolerance, not a delay. | Measure on the real doorbell. This is the number the "who is at the door" moment is built on. |
| 5 | Event History parameters, its `event_types` values, and its retention window. | Event History section, then one call. |
| 6 | Webhook retry and backoff behaviour on a non-200. | "Retry Logic" section. |
| 7 | The OAuth scope strings. `"ava"` / `"ava.v1:read"` came from one extraction of a page that truncated elsewhere. | Authentication Endpoints section. |
| 8 | Whether `motion_detected` carries a `vehicle` sub_type, or only `human`. The docs show `human`; the Playground simulates Package/Vehicle/Motion for **live view**, which may be a different taxonomy. | Playground capture. |
| 9 | **Whether TAKE will be on by default on this account's Battery Doorbell Pro by November.** Press and the release note say default; the consumer support article describes opt-in enrolment. | Check the device in the Ring app now, and again before judging opens. |
| 10 | Whether the Partner API returns Ring Alarm Z-Wave sensors at all. | Link a Ring Alarm sensor, call `GET /v1/devices`. |
| 11 | Whether FL-012's staging blocker is actually lifted for this account. The rule changed on 2026-09-11; this account has not tested it. | Authorise the account on the Test page and wait for a `motion_detected`. |
| 12 | Approval time for Ring developer registration and identity verification. No published figure. | Nothing to do but observe; the 48-hour figure is for public-app certification and does not apply to a private app. |

---

## 11. The four findings that would most change Plan 4

Ordered by how much of the plan they move.

1. **There are no documented sensor webhook events.** Spec §6.3's `sensor-rules` handler is built on three event names that appear nowhere in Ring's documentation, and the one sentence Ring has published about sensors points at `devices` resources on existing endpoints — which reads as polling. If that is right, the sensor half of the Ring pipeline is a different architecture from the one the spec drew. **Settle this before writing a single sensor task**, with one linked sensor and one fault.

2. **TAKE is becoming the default and blocks partner media entirely.** A TAKE device stays in the API and returns content the app cannot read — no snapshots, no clips, no live stream — and Ring's own consumer documentation lists third-party integrations among the features that require pausing TAKE. The doorbell snapshot is the Ring track's centrepiece. FL-014 called this undocumented; it is documented now and the answer is worse than the spec's "verify it is off" assumed, because the default is moving underneath the device rather than sitting still.

3. **The staging subscription ticket is probably already unnecessary.** The known gap FL-012 records was closed on 2026-09-11: staging users no longer go through a purchase or subscription activation step. If that holds for this account, a support ticket and its unknown turnaround drop out of the critical path entirely — which is the single biggest schedule risk in the spec's timeline. The per-account Ring Protection plan is still required, and that is the thing to check instead.

4. **Two numbers in the spec are wrong, and one of them is a hardware order.** A private app supports **5** allowlisted accounts, not 10 (10 is the staging-user limit). And the Partner API's sensor family is the **Ring Sensors (Amazon Sidewalk)** line — hubless, bridge-connected, including a temperature/humidity sensor and an air quality monitor that have no Ring Alarm equivalent — not the Ring Alarm "2nd gen" Z-Wave sensors the spec's timeline says to order. Check what arrived in the box.

---

## 12. Sources

Ring / Amazon, official:

- [Ring Partner API Documentation](https://developer.amazon.com/docs/ring/api-documentation.html) — endpoints, webhook envelope and signature, event types, rate limit, sensor family contents
- [Ring Appstore API Release Notes](https://developer.amazon.com/docs/ring/release-notes.html) — 2026-09-16 TAKE/E2EE, 2026-09-15 unlink, 2026-09-11 staging subscriptions, 2026-08-24 dynamic scopes and sensors, 2026-08-20 multi-camera, 2026-08-13 partner-initiated OAuth, 2026-07-21 private apps, 2026-06-08 watermark, 2026-05-28 Playground, 2026-04-21 GA
- [Getting Started](https://developer.amazon.com/docs/ring/get-started.html) — base URL, registration, identity verification, credentials
- [Configure Phase](https://developer.amazon.com/docs/ring/configure.html) — private vs public apps, dynamic scope groups, webhook URL and HMAC key
- [Ring API Development Guide](https://developer.amazon.com/docs/ring/develop.html) — 10 staging users, webhook 200-within-5s, `request_id` idempotency
- [Certify Your Ring Application](https://developer.amazon.com/docs/ring/certify.html) — public-app review timing
- [Developer FAQ](https://developer.amazon.com/docs/ring/developer-faq.html) — TAKE and E2EE effects on partner apps, staging vs production subscription requirements
- [Ring Appstore MCP Server](https://developer.amazon.com/docs/ring/ring-mcp.html) — `search_docs`, `get_doc`, endpoint
- [AmazonAppDev/ring-api-helloworld](https://github.com/AmazonAppDev/ring-api-helloworld) — corroborates base URL and seven endpoints
- [Amazon Sidewalk compatible devices](https://ring.com/support/articles/b4lyi/Amazon-Sidewalk-Compatible-Devices) — the Ring Sensors line
- [Using TAKE (Throw Away the Key Encryption)](https://ring.com/gb/en/support/articles/m508l/Using-TAKE-Throw-Away-the-Key-Encryption) — enrolment, pausing, reset warning, third-party integrations

Amazon Developer Community (Ring staff on the record):

- [Obtaining a camera snapshot](https://community.amazondeveloper.com/t/obtaining-a-camera-snapshot/28387) — no on-demand capture, recordings only, ±10 s, consent-date 403
- [Issue testing staging app with motion events](https://community.amazondeveloper.com/t/issue-testing-staging-app-with-motion-events/28731) — the known staging-subscription gap, 2026-07-13

Unofficial, cited only where marked and never as fact:

- [josepha-mayo/ring-sandbox](https://github.com/josepha-mayo/ring-sandbox) — `faulted` semantics, battery `255` sentinel, 303 redirect, webhook v1.1 `sub_type`/`component_ids`
- [josepha-mayo/attest](https://github.com/josepha-mayo/attest) — Playground cannot reach a localhost webhook; no sensor in the Playground

TAKE rollout context: [TechCrunch, 2026-08-26](https://techcrunch.com/2026/08/26/ring-introduces-a-new-encryption-standard-makes-it-the-default-for-cloud-features/) · [About Amazon](https://www.aboutamazon.com/news/devices/ring-take-encryption) · [Engadget](https://www.engadget.com/2244922/ring-introduces-better-default-encryption-standards-to-address-privacy-concerns/)
