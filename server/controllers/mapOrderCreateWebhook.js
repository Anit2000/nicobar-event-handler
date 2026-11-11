import AWS from "aws-sdk";
import { sendMessageToSqs } from "./aws.js";

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_KEY,
});

const sqs = new AWS.SQS();

const mapOrderCreateWebhook = async (shop, payload) => {
  try {
    await sendMessageToSqs("ORDER_CREATE",shop,payload);
  } catch (err) {
    throw new Error(
      "Failed to map order create webhook reason -->" + err.message
    );
  }
};
export default mapOrderCreateWebhook;
