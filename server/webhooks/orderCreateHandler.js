import mapOrderCreateWebhook from "../controllers/mapOrderCreateWebhook.js";

/**
 * @typedef { import("../../_developer/types/2025-04/webhooks.js").ORDERS_CREATE } webhookTopic
 */
/**
 * SQS event payload
 * topic - [ORDER_CREATE]
 */

const orderCreateHandler = async (
  topic,
  shop,
  webhookRequestBody,
  webhookId,
  apiVersion
) => {
  /** @type {webhookTopic} */
  const webhookBody = JSON.parse(webhookRequestBody);
  try {
    console.log("order create webhook triggered");
    await mapOrderCreateWebhook(shop, { ...webhookBody, shop });
    console.log("Order webhook passed to sqs ✅");
  } catch (err) {
    console.log("failed to pass order webhook to sqs ❌", err.message);
  }
};

export default orderCreateHandler;
