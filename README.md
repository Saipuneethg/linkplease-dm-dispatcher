# LinkPlease — Instagram DM Automation Engine

> **GitHub Repository**: [https://github.com/Saipuneethg/linkplease-dm-dispatcher](https://github.com/Saipuneethg/linkplease-dm-dispatcher)

High-throughput, fault-tolerant Instagram DM automation engine built for scale. Automatically monitors post comment webhooks, matches trigger rules, deduplicates user deliveries, enforces strict rate limits, and reconciles asynchronous delivery statuses against hostile mock APIs.

---

## Technical Overview & Features

- **Fast ACK Webhook Handler (`POST /webhook`)**: Immediate `<50ms` HTTP 200 response with async background queueing; constant-time HMAC-SHA256 signature verification (`X-PseudoGram-Signature`).
- **Rules Engine API (`POST /rules`, `GET /rules`)**: Dynamic keyword matching supporting case-insensitive substring matching.
- **Rule & User Level Deduplication**: Atomic MongoDB unique compound index `{ rule_id: 1, user_id: 1 }` preventing duplicate DMs to the same user for the same rule.
- **FIFO Rate-Limited Dispatcher**: Outbound queue dispatcher enforcing a strict 6.1-second delay between calls (~9.8 req/60s max) to safely guarantee compliance with the 10 req/60s rate limit.
- **Delivery Status Reconciler**: Background polling loop querying `GET /v1/dm/{dm_id}` to reconcile accepted DMs (202) to `delivered` or retry on transient errors.
- **Pre-Send Deletion Cancellation**: Listens for `comment.deleted` events and drops queued DMs before calling the outbound DM API.
- **Failure Edge Case Analysis**: Comprehensive [`FAILURES.md`](FAILURES.md) document detailing 4 realistic production edge cases, failure impacts, and architectural mitigations.

---

## Terminal & Endpoint Output Verification

### 1. Root Status Endpoint (`GET /`)
Returns a clean JSON status payload detailing server health and available API routes:

![Root Status Endpoint JSON Response](screenshots/root_endpoint.png)

---

### 2. Live API Testing (`GET /stats` & `POST /rules`)
PowerShell REST execution demonstrating live stats retrieval and 201 Created rule creation:

![PowerShell Terminal API Output](screenshots/powershell_terminal.png)

---

## API Reference

### 1. `POST /webhook`
Receives comment events from Instagram webhook system.
- **Headers**: `X-PseudoGram-Signature: sha256=<hex_hmac_digest>`
- **Response**: `200 OK` `{"status": "acknowledged"}`

### 2. `POST /rules`
Creates a new keyword trigger rule.
- **Body**: `{"keyword": "PRICE", "dm_message": "Here is the price list: $99"}`
- **Response**: `201 Created`
```json
{
  "rule_id": "rule_1786969252065_j29cd",
  "keyword": "PRICE",
  "dm_message": "Here is the price list: $99"
}
```

### 3. `GET /rules`
Lists all active automation rules.

### 4. `GET /stats`
Returns live processing statistics.
- **Response**: `200 OK`
```json
{
  "sent": 142,
  "failed": 3,
  "queued": 8,
  "duplicates_blocked": 57
}
```

---

## Automated Test Suite

Run the full Jest integration test suite:

```bash
npm test
```

### Test Results
```bash
PASS ./server.test.js
  1. Webhook Signature Verification (HMAC-SHA256)
    √ should return 403 Forbidden if X-PseudoGram-Signature header is missing (147 ms)
    √ should return 403 Forbidden if X-PseudoGram-Signature is invalid (31 ms)
    √ should return 200 OK when X-PseudoGram-Signature is valid (77 ms)
  2. Event Deduplication (event_id)
    √ should return duplicate_event_ignored on receiving duplicate event_id (92 ms)
  3. Rules Engine API (/rules)
    √ should create a new rule with 201 Created (42 ms)
    √ should list active rules via GET /rules (41 ms)
  4. Keyword Matching & Rule-User Deduplication
    √ should queue a DM job for keyword match (case-insensitive) (165 ms)
    √ should parse user_id from nested data.from.user_id matching exact spec payload shape (173 ms)
    √ should block duplicate DMs for same user and rule, incrementing duplicates_blocked (370 ms)
  5. Pre-Send Deletion Handling
    √ should cancel pending DM job when comment.deleted event arrives (339 ms)
  6. GET /stats Endpoint
    √ should return accurate sent, failed, queued, and duplicates_blocked counts (127 ms)

Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total
Snapshots:   0 total
Time:        6.085 s
```

---

## Getting Started & Local Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/Saipuneethg/linkplease-dm-dispatcher.git
   cd linkplease-dm-dispatcher
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env` and fill in your connection variables:
   ```bash
   cp .env.example .env
   ```

4. **Start the Engine**:
   ```bash
   npm start
   ```

---

## Repository Artifacts
- **Production Failure Edge Cases**: [`FAILURES.md`](FAILURES.md)
- **GitHub Repository**: [https://github.com/Saipuneethg/linkplease-dm-dispatcher](https://github.com/Saipuneethg/linkplease-dm-dispatcher)
