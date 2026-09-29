# HomeLedger demo video: plan, script, and shot list

The submission video for Build, Ship, Shape (Alexa+ primary, Ring secondary, AWS Builder and Open Source minis). Every exchange on screen is real: the tool calls hit the deployed AgentCore runtime, the doorbell press is a real Ring event, and the flood alert is a real sensor. Nothing is a recorded response, and nothing is staged in the data except the reseed before recording.

## 1. Constraints this plan is built around

**From the official rules** (amazonappdev2026.devpost.com/rules, read 2026-09-29):

- The video must run under three minutes, and judges do not have to watch past 3:00. **Target 2:45.**
- It must be public on YouTube or Vimeo.
- It must show the project working on the device it was built for. That means the simulated display and the real Ring doorbell and sensor, filmed physically.
- No third-party trademarks, and no copyrighted music or other material, unless we have permission. This rule is what the brand-name steps in §6.2 are for.
- Judging weights four criteria equally: Tech Implementation, Design, Potential Impact, Quality of the Idea. Each segment below names the criterion it carries.
- The deadline is **Friday 2026-10-23, 12:00 PT**.

**From the system:**

| Fact | Consequence for the shoot |
|---|---|
| `book_service` only offers three windows, 8–10 AM Central, two to four days after the booking date (`availabilityWindows`, `apps/mcp-server/src/tools/service.ts`). | The booking and the arrival can't be filmed in one take. Book on day D; the doorbell scene is filmed on the morning of D+2, inside the booked window. The video says so ("Thursday morning"). |
| The windows are computed from the **UTC** date of the booking. | Film the booking before 7 PM Central (00:00 UTC). Later than that, the windows shift a day. |
| A press counts as an arrival within the visit window plus or minus 30 minutes (`ARRIVAL_SLACK_MS`). | Press between **7:30 and 10:30 AM Central** (8:30–11:30 AM Eastern). Aim for 8:15–9:30 AM Central. |
| `ask_manual` can't retrieve anything while the account's Bedrock block stands. Smoke on 2026-09-29 still printed `ask_manual: SKIPPED`. | The manual Q&A is **not** in the video. If the block lifts before the shoot and a smoke run enforces `assertManualPassages`, add the 15-second optional segment in §4. |
| Appliance brands appear only in `list_appliances` and `get_appliance` and their two widgets. The simulator reads the appliance list as a resource when it connects, so the model has the water heater's id for `book_service` without calling either tool, but it does see the brands. | Never ask for the appliance list or one appliance's details on camera. Retake any take where the model calls either tool, or names a brand (§6.2). |
| A flood alert that clears and comes back within 2 minutes reopens the same alert (FL-063). | Use a shallow dish of water, not a damp cloth, so the probes stay wet and there's one clean alert. |
| The simulator takes typed input only, and its replies are text. | The video is typed prompts plus a voice-over. Speed up the typing in the edit. |
| The model's wording differs between runs. | The script gives the expected **substance** of each reply, not exact text. Take each prompt two or three times and keep the best. |

## 2. Story

One household and one week. The display knows the house's upkeep, books the plumber, knows when the plumber is at the door, and notices water on the floor. The arc runs **Ask → Book → Arrive → Alert**, then 15 seconds under the hood.

**Hook** (first 10 seconds): the finished arrival card, shown before any explanation. A real press, then "Anode and Company is at the door", with the photo.

## 3. Shot list and timing

The times are cut points in the finished video. VO = voice-over, recorded separately. SCR = screen recording of the simulator. CAM = phone footage.

| # | Time | Segment | Source | Carries |
|---|---|---|---|---|
| 1 | 0:00–0:10 | Hook: doorbell press, then the arrival card | CAM + SCR from Session B | Idea, Design |
| 2 | 0:10–0:22 | Title and one-line pitch | Title card, then SCR idle display | Idea |
| 3 | 0:22–0:52 | **Ask**: what's due, then logging the filter change | SCR, Session A | Design, Impact |
| 4 | 0:52–1:32 | **Book**: provider card, window card, progress, confirmation, visit card | SCR, Session A | Tech, Design |
| 5 | 1:32–2:02 | **Arrive**: "Thursday, 8:40 AM"; press, card, photo, one sentence | CAM + SCR, Session B | Tech, Idea |
| 6 | 2:02–2:27 | **Alert**: water by the water heater; alert card; asking whether it's still active | CAM + SCR, Session B | Impact, Tech |
| 7 | 2:27–2:40 | **Under the hood**: debug drawer, then architecture frame | SCR + still | Tech |
| 8 | 2:40–2:47 | Close: repo URL and friction log | Title card | Open Source |

## 4. Script

The prompts are exact; type them as written. The "Expect" lines are what must happen for the take to count.

### 1. Hook (0:00–0:10)

- **CAM:** a hand presses the mounted doorbell. The helper is in work clothes with a toolbox.
- **SCR:** the notice "Home event: the doorbell matched a booked visit." arrives, then the visit card with the photo.
- **VO:** "That's my plumber. My kitchen display knew before I opened the door."

### 2. Title (0:10–0:22)

- **Title card:** **HomeLedger**, subtitle "Your home's operating record, for an Alexa+ assistant."
- **VO:** "HomeLedger is a self-hosted MCP server that keeps a home's record: appliances, maintenance, service visits, and what the doorbell and sensors see. The display is a simulated Alexa+ surface; the server, the doorbell and the sensor are real."

### 3. Ask (0:22–0:52)

1. Type: `What's due around the house?`
   - Expect: `maintenance_due` runs and the maintenance calendar widget renders. The spoken reply names up to five overdue items, including the furnace filter.
   - VO: "Ask what needs doing and the server answers in one sentence you could say out loud, with the whole schedule beside it."
2. Type: `I changed the furnace filter this morning.`
   - Expect: `log_maintenance` runs, the filter drops off the overdue list, and the next due date is about 90 days out.
   - VO: "Tell it what you did, and the schedule moves."

### 4. Book (0:52–1:32)

1. Type: `The water heater is making a popping noise. Book someone to look at it.`
   - Expect, in order:
     1. the provider card, with three sample providers;
     2. **pick Anode and Company**, which matches the hook;
     3. the arrival-window card with three windows, in Central time;
     4. **pick the first window** (Thursday 8 to 10 AM);
     5. the progress meter, 0 to 3, "checking availability";
     6. the confirmation card; **confirm**;
     7. the visit card.
   - VO, over the cards: "Booking pauses the conversation three times through MCP elicitation: who, when, and a final yes. The same handler serves the 2025 protocol the Alexa+ docs describe and the current one. The providers are labelled sample data. The visit is real, and it's in the database."
2. Optional, if time allows: type `When is the plumber coming?`
   - Expect: `get_visit` or `recent_events`, returning the Thursday window. Cut this first if over time.

### 5. Arrive (1:32–2:02), filmed in Session B

- **Caption:** "Thursday, 8:40 AM"
- **CAM:** the helper walks up and presses the bell. Hold on the door for 2 seconds.
- **SCR:** hold on the idle display. The notice arrives within about 10 seconds, then the assistant's sentence, then the visit card with the photo and one sentence describing what's visible.
- **VO:** "The press is a real Ring event. A signed webhook reaches API Gateway; a Lambda checks the signature and hands it to EventBridge. The visit correlator matches it to Thursday's window, pulls the frame from Ring's recording, and Claude writes one sentence about what's visible, never who. The card is pushed to the display over a WebSocket. From button to card is about eight seconds."
- **Caption, lower third:** "Press to card: 8 s (measured live, 2026-09-29)." Replace this with the Session B timing from the logs (§7).

### 6. Alert (2:02–2:27), filmed in Session B

- **CAM:** set the Flood & Freeze sensor down in a shallow dish of water beside the water heater.
- **SCR:** the notice "Home event: an alert was raised.", then the assistant reads the flood alert and says it is **still active**. The water heater's inspection gains the note "Check for a leak near the Water Heater". The seeded inspection is already overdue, so it keeps its date rather than moving to today.
- Then: lift the sensor out and dry the probes. Wait 20 seconds and type `Is the water heater still leaking?`
  - Expect: `recent_events` says the alert **cleared at** its time.
- **VO:** "The flood sensor is on Amazon Sidewalk and reports through Ring's Partner API. The alert arrives by webhook within seconds, and a two-minute poll backs it up. It also puts a leak check on the water heater's maintenance. When the water's gone, it says so."

### 7. Under the hood (2:27–2:40)

- **SCR:** open the debug drawer. Hold on the negotiated protocol, the session id, and a few `tools/call` lines with their timings.
- **Still:** `docs/assets/architecture.png`, a 1920×1080 slide showing the two paths as a loop: every turn goes display → MCP server on AgentCore → household record, and every home event goes Ring → API Gateway + Lambda → EventBridge → correlator or rules → WebSocket push → display. Its source is `docs/assets/architecture-slide.html`.
- **VO:** "Every turn is a real Streamable HTTP call to Bedrock AgentCore Runtime with a Cognito token. Everything's Terraform, applied only from GitHub Actions."

### 8. Close (2:40–2:47)

- **Title card:** `github.com/jkarns87/homeledger`, with "MIT · Friction log: 60+ entries".
- **VO:** "The code, the tests, and a friction log of everything that surprised me are in the repo."

The VO totals about 300 words, which is roughly 2:00 at a natural pace. That leaves room for the screen to breathe.

### Optional segment, only if Bedrock clears first

After the Ask segment (+0:15), cut the optional booking readback to make room.

- Type: `What does F21 mean on the washer?`
- Expect: `ask_manual` answers with a passage and its page number.
- Precondition: a smoke run that **enforces** `assertManualPassages` instead of printing SKIPPED. Then update the Devpost PENDING entry in the same pass.

## 5. Schedule

| Date (2026) | What | Notes |
|---|---|---|
| Wed Sep 30 | **Rehearsal A**: run §6.1 and §6.2, then Segments 3–4 off the record. Book the first window, **Fri Oct 2, 8–10 AM CT**. | Settles the prompts, the pacing and the recorder settings. |
| Fri Oct 2 | **Rehearsal B**: Segments 5–6 in the window. Pull the timings (§7). | Proves the mounted doorbell, the helper's position and the sensor dish. |
| Tue Oct 13 | **Session A (record)**: Segments 2–4 and 7. Book **Thu Oct 15, 8–10 AM CT** on camera. Then, off camera, book a backup with Kettle Creek for **Fri Oct 16, 8–10 AM CT**. | Record before 7 PM CT. Don't run `smoke.yml` after this point: it reseeds the household and wipes the booking. |
| Thu Oct 15 | **Session B (record)**: Segments 1, 5 and 6, pressing 8:15–9:30 AM CT. Record VO the same day. | If the arrival take fails, re-shoot Fri Oct 16 against the backup visit. The backup provider's name appears on the card; rename the provider in VO and captions to match, or re-record Segment 4's pick. |
| Fri Oct 16 to Sun Oct 18 | Edit, captions, upload unlisted, review. | |
| Sun Oct 18 | Upload public to YouTube and do a dry-run Devpost submission. | Matches the spec's dry run by Oct 18. |
| Mon Oct 19 | AWS credit form closes. | Unrelated to the video; don't miss it. |
| Fri Oct 23, 12:00 PT | Deadline. | |

## 6. Actions

### 6.1 Setup, the day before any session

1. **Hardware**
   - Mount the doorbell at the front door; it's currently on a desk facing its own box. Charge it.
   - Put the Flood & Freeze sensor beside the water heater.
2. **Ring app**
   - Rename the devices so the spoken text reads naturally: the doorbell to **Front Door**, the sensor to **Water Heater**. Names come from device sync, which runs on its schedule or by hand (step 4).
   - Control Center → Video Encryption: confirm there's **no TAKE and no end-to-end encryption**. Never press "Reset Account Encryption".
3. **AWS session:** run `aws login --profile homeledger-admin` and check it with `aws sts get-caller-identity --profile homeledger-admin`.
4. **Ring link health**
   ```bash
   aws logs tail /aws/lambda/demo-homeledger-token-refresh --since 2h --format short \
     --profile homeledger-admin --region us-east-1 | grep '"msg"' | tail -3
   ```
   Expect `fresh` or `refreshed`. `not-linked` means re-link (RUNBOOK §4.7).
5. **Reset the household** to the seed. This wipes visits, alerts, events and device rows; then device sync restores the devices.
   ```bash
   pnpm --filter @homeledger/core build
   TABLE_NAME=demo-homeledger HOUSEHOLD_ID=hh_harlow AWS_REGION=us-east-1 AWS_PROFILE=homeledger-admin \
     pnpm --filter @homeledger/scripts seed:remote
   aws lambda invoke --function-name demo-homeledger-device-sync \
     --payload '{"detail-type":"Scheduled Event","source":"homeledger.schedule","detail":{}}' \
     --cli-binary-format raw-in-base64-out /dev/stdout --profile homeledger-admin --region us-east-1
   ```
   Then confirm two `DEVICE#` rows with the new names (RUNBOOK §4.7 query). The doorbell reads `kind: other` until its first press, which is expected: the first press teaches it.
   - Do this **before Session A only**. Resetting before Session B deletes the booked visit.

### 6.2 Setup, each session

1. **Simulator**
   - Run `pnpm build`, then `pnpm --filter @homeledger/simulator dev`.
   - `apps/simulator/.env.local` holds `HOMELEDGER_PUSH_URL`. It was added on 2026-09-29; check it's still there.
   - In the drawer, confirm "push channel connected" and "9 tools".
2. **Warm-up:** ask one throwaway question (`What's due this week?`) so the cold connect isn't on camera. Then reload the page to clear the transcript. The page resets its conversation on load, and the push channel reconnects; wait for "push channel connected" again.
3. **Screen**
   - Close every other tab and hide the bookmarks bar. Turn on Do Not Disturb.
   - Size the browser so the display canvas fills the frame. Record the screen at 60 fps with the system cursor visible.
4. **Drawer:** keep the debug drawer **closed** except in Segment 7.
5. **Brand check.** Retake immediately if any of these happens:
   - a reply or widget shows an appliance brand (Carrier, Rheem, LG, Bosch, Samsung, Zoeller);
   - the model calls `list_appliances` or `get_appliance`;
   - a reply names a third-party product.
6. **Session B only**
   - Set the Ring Alarm to **Disarmed**. The sensor alarms in every mode and has no dispatch, but the siren and automated call will still come. Silence the phone for the take.
   - Set up the phone camera on a tripod facing the door; a second angle on the water heater is optional.
   - The helper waits out of frame and presses only on your cue, once the screen recording is rolling.

### 6.3 During takes

- One prompt per take, with a 3-second pause before typing.
- Session B: don't retry a press within 60 seconds. A second press in the window reads as already arrived and shows nothing.
- If the arrival card doesn't arrive within 30 seconds, stop and run the §7 trace before trying again.

### 6.4 After Session B

1. Set the Ring Alarm back to its usual mode.
2. Pull the timings (§7) and replace the "8 s" caption with the real number.
3. Record FL entries only for anything that surprised you, at the next free number.
   - Capture the last two Devpost gallery images while the cards are on screen: the arrival card with its photo, and the flood alert card. Screenshot the simulator's `.device` element into `docs/assets/devpost/raw/`. Frame each with `docs/assets/devpost/frame.html` as `09-arrive.png` and `10-alert.png`, and upload them after `08-architecture.png`. If the Connection drawer is open, mask the account id in the invocation URL first; it appears nowhere else in the repo.
4. Move the verified Ring and sensor sentences above PENDING in `docs/submission/devpost-story.md`, using the numbers from Session B.

## 7. Timing and trace commands

For the press → card timing and for diagnosing a failed take:

```bash
for f in webhook visit-correlator sensor-rules push; do
  echo "== $f"
  aws logs tail /aws/lambda/demo-homeledger-$f --since 15m --format short \
    --profile homeledger-admin --region us-east-1 | grep '"msg"' | cut -c1-260 | tail -4
done
```

Read the Ring event time from the visit row's `arrivedAt` or the alert's `at`, and the push time from the `push` line. Their difference is the caption number. The correlator line also carries `snapshotLatencyMs` for the VO if wanted.

**Failure modes**

| Symptom | Likely cause | Fix |
|---|---|---|
| No webhook line | Ring didn't deliver, or the link lapsed | Check token-refresh (step 6.1.4). Re-link if the log says `not-linked`. |
| `visit-correlator` says `no-visit` | Pressed outside the window ± 30 min, or the household was reset after booking | Check the clock; re-book; re-shoot the next morning. |
| Snapshot status `unavailable` or `encrypted` | Recording not ready, or TAKE was turned on | Retake after 2 minutes; check Video Encryption. |
| Push `sent: 0` | Simulator not connected | Check the drawer shows "push channel connected"; reload the page. |
| Several alert cards | Probes intermittently wet | Use the dish; FL-063's reopen window absorbs flicker under 2 minutes. |

## 8. Edit and upload

- **Length:** 2:40–2:50. Check the final export's running time; YouTube rounds the displayed length.
- **Captions:**
  - burn in the timing captions;
  - upload an SRT of the VO for accessibility;
  - the on-screen disclosure line is always visible in the simulator. Keep it legible and don't crop it out.
- **Music:** none, or a track that's explicitly licensed for this use. No copyrighted music.
- **Logos:** the Ring watermark on the snapshot is Ring's own image, and Ring is a sponsor track. Leave it intact; the design spec requires the watermark kept. Don't add other logos. The title card shows no Amazon or Alexa marks.
- **Upload:**
  - YouTube, **Public**, title "HomeLedger — a home's operating record for Alexa+ and Ring (Build, Ship, Shape)";
  - the description links the repo and the friction log;
  - paste the URL into the Devpost submission.
