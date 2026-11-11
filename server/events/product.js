/**
 * @typedef { import("../../_developer/types/2025-04/webhooks.js").APP_UNINSTALLED } webhookTopic
 */

const productEventHandler = async (
  topic,
  shop,
  eventRequestBody,
  webhookId,
  apiVersion,
  handle
) => {
  /** @type {webhookTopic} */
  const webhookBody = JSON.parse(webhookRequestBody);
  console.log(webhookBody);
};

export default productEventHandler;
