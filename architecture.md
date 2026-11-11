# Architecture

## System Overview

```
Shopify
  │
  │  POST /api/webhooks/orders_create
  │  (HMAC-signed)
  ▼
┌─────────────────────────────────────────┐
│          Express Server                 │
│                                         │
│  1. Verify Shopify HMAC signature       │
│  2. Parse order payload                 │
│  3. sendMessageToSqs()   → ACK 200      │
└──────────────────┬──────────────────────┘
                   │
                   ▼
        ┌──────────────────┐
        │  AWS SQS (main)  │
        │  nicobar-orders  │
        └────────┬─────────┘
                 │  long-poll (WaitTimeSeconds: 20)
                 ▼
┌────────────────────────────────────────────┐
│          sqsEventConsumer (background)     │
│                                            │
│  for each message:                         │
│    parse body → dispatch on topic          │
│    ┌─────────────────────────────────┐     │
│    │  case ORDER_CREATE              │     │
│    │    handleOrderCreate()  ──────────────► OMS
│    │    deleteMessage()      ◄ success│     │   │
│    └─────────────────────────────────┘     │   ▼
│                                            │  WMS
│    on failure:                             │   │
│      sendToDLQ()                           │   ▼
│      deleteMessage()                       │ Logistics
└────────────────────────────────────────────┘
                 │
                 ▼ (on failure)
        ┌──────────────────────┐
        │  AWS SQS (DLQ)       │
        │  nicobar-orders-dlq  │
        └──────────────────────┘
                 │
                 ▼ (future)
        CloudWatch Alarm → SNS → Email / PagerDuty
```

---

## Why SQS — not fire-and-forget

A fire-and-forget design would call the OMS directly inside the webhook handler, return `200` to Shopify, and discard any error. That is simple but it fails badly under three real conditions:

**1. OMS is unavailable.**
If the OMS call fails, the order is gone. Shopify's own retry mechanism will resend the webhook up to 19 times over 48 hours, but this is out of your control — the intervals are fixed, retries happen even if the OMS comes back in five minutes, and there is no hook to trigger an immediate retry once the OMS recovers. With SQS, the message sits safely in the queue with a configurable visibility timeout. The consumer keeps attempting until the OMS responds, then deletes the message.

**2. The same webhook arrives multiple times.**
Shopify guarantees at-least-once delivery, not exactly-once. Fire-and-forget processes every delivery immediately, so three copies of the same webhook create three orders in the OMS. With a queue-based approach the consumer uses a MongoDB idempotency store keyed on the Shopify order ID to deduplicate before forwarding.

**3. One particular order keeps failing.**
With fire-and-forget there is no way to isolate the bad order — either the entire handler breaks or the error is silently swallowed. With SQS + DLQ, the bad message circulates on the main queue up to `MaxReceiveCount` times, then lands in the DLQ. Everything else keeps processing normally. The DLQ entry preserves the original payload, the failure reason, the original message ID, and the timestamp — enough to debug and replay the order manually.

---

## Handling the three assignment failure scenarios

### Shopify sends the same order webhook three times

Each delivery creates a separate SQS message. All three are currently processed.

`handleOrderCreate` in `server/controllers/aws.js` uses MongoDB's unique index as the idempotency gate. It attempts to insert a record for the order ID; if the insert succeeds the order is new and processing continues; if MongoDB returns a duplicate-key error (`11000`) the order was already handled and the message is skipped silently. Any other error propagates up to `processMessage` and routes to the DLQ as normal.

```js
const handleOrderCreate = async (body) => {
  const { shop, ...orderData } = body;
  try {
    await ProcessedOrderModel.create({ orderId: String(orderData.id), shop });
  } catch (err) {
    if (err.code === 11000) {
      console.log(`→ Duplicate ORDER_CREATE skipped — order ${orderData.id} already processed`);
      return;
    }
    throw err;
  }
  // ... forward to OMS
};
```

`ProcessedOrderModel` (`utils/models/ProcessedOrderModel.js`) has a unique index on `orderId` and a TTL index (`expires: "7d"`) so records self-delete after a week with no manual cleanup. Using the unique index as the guard rather than a check-then-insert pattern means two concurrent messages for the same order cannot both pass — the second `create` call will always throw `11000`.

### OMS is unavailable for 30 minutes

The consumer throws when the OMS call fails. `processMessage` catches it, calls `sendToDLQ`, and deletes the message from the main queue.

However, if OMS downtime is temporary and the message should be retried rather than moved straight to DLQ, increase `MaxReceiveCount` on the main queue (e.g. `10`) and reduce `VisibilityTimeout` in the consumer (e.g. `60s`). AWS will keep the message visible after each timeout expiry, giving the consumer roughly `MaxReceiveCount × VisibilityTimeout` total window before the message goes to the DLQ — enough to cover a 30-minute outage.

For a smarter retry, replace the immediate catch-and-DLQ with exponential backoff before re-throwing:

```js
// inside processMessage, before sendToDLQ
await retryWithBackoff(() => handleOrderCreate(body), { retries: 5, base: 2000 });
```

### Processing for one order keeps failing

After `MaxReceiveCount` delivery attempts on the main queue (configured in the AWS Redrive Policy), AWS automatically moves the message to the DLQ. The application-level `sendToDLQ` call in `processMessage` also forwards it immediately on a thrown error, with `FailureReason`, `OriginalMessageId`, and `FailedAt` attributes attached, so both paths are covered.

The dead message is isolated. All other orders continue processing. The DLQ preserves the full original payload for manual replay once the root cause is fixed.

---

## Current monitoring — initial setup

The CloudWatch alarm layer is not yet wired up. For this initial build, webhook delivery can be monitored from two places:

**Shopify Partner Dashboard**
- Partners Dashboard → App → Notifications → Webhooks → Recent webhook deliveries.
- A `200` response confirms the webhook was received, validated, and enqueued. This covers the ingestion half of the pipeline.

**Server logs**
- `→ Processing ORDER_CREATE for shop: …` — consumer picked up the message.
- `✅ ORDER_CREATE processed` — handler completed without error.
- `❌ Failed to process [ORDER_CREATE] …` — handler threw; check the reason and the DLQ.

---

## Setting up DLQ alarms (next step)

Once the queues exist in AWS, add a CloudWatch alarm on the DLQ:

1. Open **CloudWatch** → **Alarms** → **Create alarm**.
2. Select metric: **SQS** → **Queue metrics** → `nicobar-orders-dlq` → `ApproximateNumberOfMessagesVisible`.
3. Condition: **Greater than 0** for **1 out of 1** data point (1-minute period).
4. Action: Send to an **SNS topic** → subscribe your on-call email or Slack webhook.
5. Name the alarm `nicobar-dlq-has-messages`.

This fires within one minute of any order landing in the DLQ — covering both the "OMS is down and exhausted retries" and the "one bad order keeps failing" scenarios.

A second alarm on `NumberOfMessagesSent` dropping to zero for more than 10 minutes during peak hours catches situations where the ingestion side has gone silent (Shopify not reaching the server at all).

---

## Extending to new event topics

Add a handler function and a `case` in the switch inside `server/controllers/aws.js`:

```js
const handleProductUpdate = async (body) => { /* ... */ };

// inside processMessage switch:
case "PRODUCT_UPDATE":
  await handleProductUpdate(body);
  break;
```

No changes required to the consumer loop, the DLQ forwarding, or the delete logic.
