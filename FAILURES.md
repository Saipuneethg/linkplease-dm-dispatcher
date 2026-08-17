# LinkPlease Engine — Architectural Failure Modes & Edge Cases

> [!NOTE]
> This document details four production failure scenarios, root causes, system impacts, and mitigations for the LinkPlease Instagram DM automation engine.

---

## Executive Summary

| # | Failure Mode | Trigger Condition | System Impact | Production Mitigation |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Container Restart During Dispatch Sleep** | Server restarts while job is in 6.1s rate-limit delay | Job stuck in `sending` status indefinitely | Startup DB lock cleanup resetting stale jobs (>60s) to `queued` |
| **2** | **Multi-Pod Concurrent Race Condition** | Duplicate webhooks hit Pod A and Pod B within 30ms | MongoDB `E11000` duplicate key exception | Atomic index collision catch with `$inc duplicates_blocked` |
| **3** | **Reverse Proxy Payload Tampering** | Cloudflare/ALB re-encodes or trims UTF-8 body bytes | Raw HMAC digest mismatch (`403 Forbidden`) | PassThrough binary body streaming & timing-safe equality check |
| **4** | **Reconciliation Lag vs Webhook Delivery** | `comment.deleted` arrives after status check fails | Potential zombie DM sent for deleted comment | Mandatory pre-send database check against `Comment.is_deleted` |

---

## Failure Scenario Analysis

### 1. Container Restart During Dispatch Sleep

#### Condition
The FIFO dispatcher sleeps for 6.1s between outbound `POST /v1/dm/send` calls to observe the 10 req/60s rate limit. During this sleep window, a server restart or Vercel container cold boot occurs while the job status is set to `sending`.

#### Impact
The job remains saved in MongoDB with `status: "sending"`. On restart, queue queries looking for `status: "queued"` skip this orphaned job, leaving the DM un-delivered.

#### Mitigation Strategy
Execute an automated stale lock cleanup on server boot:

```javascript
// Reset orphaned jobs stranded in 'sending' state for more than 60 seconds
await DmJob.updateMany(
  { status: 'sending', updatedAt: { $lt: new Date(Date.now() - 60000) } },
  { $set: { status: 'queued', updatedAt: new Date() } }
);
```

---

### 2. Multi-Pod Concurrent Race Condition on Compound Index (`E11000`)

#### Condition
Under high-concurrency bursts (e.g. 500 comments in 10s), Instagram re-delivers duplicate webhooks that reach separate application pods (Pod A and Pod B) at the same millisecond:
- **T = 0ms**: Pod A queries `UserRuleDelivery` for `(rule_id, user_id)` -> Returns `null`.
- **T = 2ms**: Pod B queries `UserRuleDelivery` for `(rule_id, user_id)` -> Returns `null`.
- **T = 5ms**: Both pods attempt to insert into `UserRuleDelivery`.

#### Impact
Pod A's insert succeeds while Pod B encounters a MongoDB `E11000` duplicate key error on the unique compound index `{ rule_id: 1, user_id: 1 }`.

#### Mitigation Strategy
Atomic index collision handling prevents crash cascades and guarantees accurate metrics:

```javascript
try {
  await UserRuleDelivery.create({ rule_id: rule.rule_id, user_id, comment_id });
  await DmJob.create({ ... });
} catch (err) {
  if (err.code === 11000) {
    // Intercept duplicate key collision and update metric atomically
    await StatCounter.updateOne(
      { name: 'duplicates_blocked' },
      { $inc: { value: 1 } },
      { upsert: true }
    );
  }
}
```

---

### 3. Reverse Proxy Payload Mutation & HMAC Verification

#### Condition
Incoming webhooks pass through intermediate load balancers (AWS ALB, NGINX, Cloudflare). If a proxy modifies, re-encodes, or trims trailing whitespace on JSON payloads, the raw binary buffer (`req.rawBody`) differs from Instagram's original payload.

#### Impact
The recalculated HMAC digest does not match `X-PseudoGram-Signature`, returning `403 Forbidden` and causing upstream webhook retries or suspensions.

#### Mitigation Strategy
1. Retain exact un-parsed request buffers via Express middleware:
```javascript
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
```
2. Perform constant-time verification using `crypto.timingSafeEqual`:
```javascript
const providedBuf = Buffer.from(providedHex, 'hex');
const expectedBuf = Buffer.from(expectedHex, 'hex');
if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
  return res.status(403).json({ error: 'Invalid signature' });
}
```

---

### 4. Reconciliation Polling Lag vs Out-of-Order Webhooks

#### Condition
Asynchronous network delivery can cause out-of-order execution:
- **T = 0s**: `comment.created` arrives; DM is dispatched and enters `pending_check`.
- **T = 1s**: User deletes the comment on Instagram.
- **T = 2s**: Network jitter delays the `comment.deleted` webhook.
- **T = 3s**: Reconciliation worker polls `GET /v1/dm/{dm_id}` (returns `failed`), resetting job status back to `queued`.
- **T = 4s**: `comment.deleted` webhook arrives, setting `Comment.is_deleted = true`.

#### Impact
If the dispatcher re-processes the queued job without verifying deletion status, a DM would be sent for a deleted comment.

#### Mitigation Strategy
Enforce a mandatory pre-send check immediately prior to calling `POST /v1/dm/send`:

```javascript
// Verify comment deletion state before executing outbound DM request
const comment = await Comment.findOne({ comment_id: job.comment_id });
if (comment && comment.is_deleted) {
  job.status = 'cancelled_deleted';
  await job.save();
  continue; // Skip API request
}
```
