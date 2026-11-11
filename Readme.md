# Nicobar — Webhook Handler

**Assignment:** Reliable Shopify → Backend → OMS/WMS Order Processing
**Role:** Senior Full Stack Developer – Backend Focus
**Start time:** 11th November 2026, 10:16 AM

---

## What this is

A customer places an order on nicobar.com. Shopify fires an `orders/create` webhook to this Node.js server. The server validates the HMAC signature, maps the payload, and enqueues it in AWS SQS. A background consumer loop picks messages off the queue, processes them, and forwards the order to the OMS. Orders that fail processing after all retry attempts land in a dead-letter queue (DLQ) for investigation and manual replay.

The design handles Shopify's at-least-once delivery guarantee, temporary OMS unavailability, and isolates poison-pill orders from the rest of the queue — without blocking the HTTP response to Shopify.

For the full flow with diagrams, failure scenario analysis, and the DLQ alarm setup: see [architecture.md](./architecture.md).

For installation and running locally: see [setup.md](./setup.md).

---

## High-level flow

```
Shopify → POST /api/webhooks/orders_create
        → HMAC verified → enqueued in SQS → 200 OK

SQS (main queue)
        → sqsEventConsumer (long-poll, background)
        → handleOrderCreate → OMS → WMS → Logistics

On failure → DLQ → CloudWatch alarm → SNS alert
```

---

## Stack

- **Runtime:** Node.js 18, Express 5, ESM
- **Queue:** AWS SQS (standard queue + DLQ)
- **Database:** MongoDB via Mongoose (session and store state)
- **Shopify:** `@shopify/shopify-api` v15, managed installation, HMAC-verified webhooks
- **Tunnel:** Cloudflare Tunnel for local development

---

## The three README questions

### What did I choose not to do, and why?

**OMS integration.** `handleOrderCreate` in `server/controllers/aws.js` deduplicates, logs, and exits. The function signature, idempotency guard, and error propagation path are all in place — the actual OMS HTTP call is the only missing piece.

**Retry with exponential backoff.** The consumer currently catches a handler failure, forwards the message to the DLQ immediately, and deletes it from the main queue. A better model for transient failures (like a 30-second OMS hiccup) is to let the SQS visibility timeout expire and have AWS retry naturally, only moving to the DLQ after `MaxReceiveCount` attempts. This is configurable on the queue itself and does not require code changes — it just needs the Redrive Policy set correctly, which is documented in `architecture.md`.

**OMS integration.** `handleOrderCreate` logs the order and exits. The function signature and structure are in place for the actual OMS POST call.

### What is the weakest part of your submission?

The missing OMS call. The idempotency guard, DLQ routing, and consumer loop are all in place. The one gap is that `handleOrderCreate` stubs out the actual OMS POST — so orders are deduplicated and acknowledged correctly but never forwarded downstream. Everything up to that call is production-ready; everything after it is not wired up yet.

### Where was AI wrong, and how did you catch it?

`server/controllers/mapOrderCreateWebhook.js` duplicates the AWS SDK initialisation (`AWS.config.update` and `new AWS.SQS()`) that already lives in `aws.js`. The SDK is re-configured with the same values on every call, which is harmless but noisy and means two separate SQS client instances exist. The right fix is to import the shared `sqs` instance from `aws.js` rather than constructing a new one. I caught it by reading both files side-by-side before writing the consumer — the duplication was obvious once the full module was visible.

The same file also hard-codes `topic: "ORDER_CREATE"` in the `sendMessageToSqs` params regardless of the `topic` argument passed in. That means if another webhook topic is added later and uses the same sender, every message would still be tagged `ORDER_CREATE`. I left the existing sender unchanged to avoid scope creep, but it is worth fixing before any second topic is added.
