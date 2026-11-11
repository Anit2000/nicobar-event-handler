# Setup Guide

This guide covers getting the full project running locally — Shopify app, MongoDB, AWS SQS queue, and the DLQ.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | >= 18 |
| npm | >= 9 |
| MongoDB | >= 6 (local or Atlas) |
| Shopify CLI | >= 3 |
| Cloudflare tunnel (`cloudflared`) | latest |

Install global Shopify CLI dependencies if you haven't:

```bash
npm run g:install
```

---

## 1. Install dependencies

```bash
npm i --force
```

The `--force` flag is required due to minor peer-dependency conflicts between Shopify packages. No runtime functionality is affected.

---

## 2. Environment variables

Copy the example file and fill in every value:

```bash
cp .env.example .env
```

### Shopify

| Variable | Where to find it |
|----------|-----------------|
| `SHOPIFY_API_KEY` | Partners Dashboard → App → API credentials |
| `SHOPIFY_API_SECRET` | Same page, below the API key |
| `SHOPIFY_API_SCOPES` | Leave as `write_app_proxy,read_products,read_orders` |
| `SHOPIFY_APP_URL` | The `https://` URL from your tunnel (fill after step 4) |
| `SHOPIFY_API_VERSION` | Pre-filled to `2026-10` — do not change |
| `VITE_SHOPIFY_API_KEY` | Must be identical to `SHOPIFY_API_KEY` |
| `APP_NAME` | Your app's display name in Partners Dashboard |
| `APP_HANDLE` | URL-safe slug, e.g. `nicobar-event-handler` |

### MongoDB

```
MONGO_URL=mongodb://127.0.0.1:27017/nicobar-webhook-handler
```

For Atlas, paste the full connection string. Leave blank to use the default above.

### Encryption

```
ENCRYPTION_STRING=<random-32-char-string>
```

This encrypts session tokens at rest. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Keep this value safe — losing it invalidates all stored sessions.

### AWS / SQS

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | Region where your queues live, e.g. `ap-south-1` |
| `AWS_ACCESS_KEY_ID` | IAM user with `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage` |
| `AWS_SECRET_KEY` | Secret for the above IAM user |
| `SQS_URL` | URL of the main SQS queue (see step 3) |
| `SQS_DLQ_URL` | URL of the dead-letter queue (see step 3) |

---

## 3. Create SQS queues on AWS

You need two standard queues — one main queue and one dead-letter queue.

### Create the DLQ first

1. Open **SQS** in the AWS console.
2. Click **Create queue** → **Standard**.
3. Name: `nicobar-orders-dlq`
4. Leave all defaults → **Create queue**.
5. Copy the queue URL and paste it into `SQS_DLQ_URL`.

### Create the main queue

1. Click **Create queue** → **Standard**.
2. Name: `nicobar-orders`
3. Scroll to **Dead-letter queue** → enable it → select `nicobar-orders-dlq`.
4. Set **Maximum receives** to `3` (the message is forwarded to the DLQ after 3 failed delivery attempts at the AWS level, in addition to the application-level forwarding in `aws.js`).
5. Click **Create queue**.
6. Copy the queue URL and paste it into `SQS_URL`.

> The IAM user needs `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` on both queue ARNs.

---

## 4. Start the tunnel

In a dedicated terminal:

```bash
npm run cloudflare
```

Copy the generated `https://` URL. Set `SHOPIFY_APP_URL` in `.env` to this value.

---

## 5. Sync app config to Shopify

```bash
npm run update:config
```

This writes `shopify.app.toml` from your `.env` and pushes webhook subscriptions and URLs to the Partner Dashboard. Run this every time `SHOPIFY_APP_URL` changes.

Do not edit `shopify.app.toml` by hand.

---

## 6. Start MongoDB

In a dedicated terminal:

```bash
mkdir -p mongo && mongod --dbpath mongo/
```

---

## 7. Run the app

```bash
npm run dev
```

The server starts on port `8081` by default. The SQS consumer loop starts automatically alongside the Express server.

You should see in the logs:

```
→ SQS consumer started
Dev server running on localhost:8081
```

---

## 8. Install the app on your dev store

Navigate to:

```
https://your-store.myshopify.com/admin/oauth/install?client_id=<SHOPIFY_API_KEY>
```

---

## Verifying webhook delivery (initial setup)

Before the full DLQ alarm system is in place, you can confirm that webhooks are being delivered and acknowledged correctly from the Partner Dashboard:

1. Go to **Partners Dashboard** → your app → **Notifications**.
2. Click the **Webhooks** tab.
3. Under **Recent webhook deliveries**, every `orders/create` event should show a `200` response.

A `200` means the webhook reached the server, was validated, and the order was enqueued in SQS. It does not mean the consumer has finished processing — check the server logs for `✅ ORDER_CREATE processed` to confirm end-to-end flow.

---

## Terminal layout (recommended)

| Terminal | Command |
|----------|---------|
| 1 | `mongod --dbpath mongo/` |
| 2 | `npm run cloudflare` |
| 3 | `npm run dev` |
