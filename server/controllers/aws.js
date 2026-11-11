import AWS from "aws-sdk";

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_KEY,
});

const sqs = new AWS.SQS();

const sendMessageToSqs = async (topic, shop, payload) => {
  try {
    if (!topic || !shop || !payload) {
      throw new Error("Required params missing");
    }
    const params = {
      QueueUrl: process.env.SQS_URL,
      MessageBody: JSON.stringify({
        topic: "ORDER_CREATE",
        shop,
        ...payload,
      }),
    };
    return sqs.sendMessage(params).promise();
  } catch (err) {
    console.log("❌ Failed to send message to sqs reason -->" + err.message);
  }
};

const deleteMessage = (receiptHandle) =>
  sqs
    .deleteMessage({ QueueUrl: process.env.SQS_URL, ReceiptHandle: receiptHandle })
    .promise();

const sendToDLQ = async (message, reason) => {
  if (!process.env.SQS_DLQ_URL) return;
  try {
    await sqs
      .sendMessage({
        QueueUrl: process.env.SQS_DLQ_URL,
        MessageBody: message.Body,
        MessageAttributes: {
          FailureReason: { DataType: "String", StringValue: reason },
          OriginalMessageId: { DataType: "String", StringValue: message.MessageId },
          FailedAt: { DataType: "String", StringValue: new Date().toISOString() },
        },
      })
      .promise();
    console.log(`→ Message ${message.MessageId} forwarded to DLQ`);
  } catch (err) {
    console.log("❌ Failed to send message to DLQ: " + err.message);
  }
};

// ─── Topic handlers ───────────────────────────────────────────────────────────

const handleOrderCreate = async (body) => {
    try{
        const { shop, ...orderData } = body;
        console.log(`→ Processing ORDER_CREATE for shop: ${shop}, order: ${orderData.id}`);
        // sending mock data to any third party integration
        console.log(`✅ ORDER_CREATE processed — shop: ${shop}, order: ${orderData.id}`);
    }catch(err){
        throw new Error("❌ Failed to hanlder order create at consumer reason -->" + err.message)
    }
};

// ─── Per-message dispatcher ───────────────────────────────────────────────────

const processMessage = async (message) => {
  let body;
  try {
    body = JSON.parse(message.Body);
  } catch (err) {
    console.log(`❌ Malformed message body ${message.MessageId} → DLQ`);
    await sendToDLQ(message, `Invalid JSON: ${err.message}`);
    await deleteMessage(message.ReceiptHandle);
    return;
  }

  const { topic } = body;
  try {
    switch (topic) {
      case "ORDER_CREATE":
        await handleOrderCreate(body);
        break;
      default:
        throw new Error(`Unknown topic: ${topic}`);
    }
    await deleteMessage(message.ReceiptHandle);
  } catch (err) {
    console.log(`❌ Failed to process [${topic}] ${message.MessageId}: ${err.message} → DLQ`);
    await sendToDLQ(message, err.message);
    await deleteMessage(message.ReceiptHandle);
  }
};

// ─── Consumer loop ────────────────────────────────────────────────────────────

const sqsEventConsumer = async () => {
  console.log("→ SQS consumer started");
  const params = {
    QueueUrl: process.env.SQS_URL,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 20,
    VisibilityTimeout: 30,
  };

  while (true) {
    try {
      const data = await sqs.receiveMessage(params).promise();
      if (!data.Messages?.length) continue;

      console.log(`→ Received ${data.Messages.length} message(s)`);
      await Promise.all(data.Messages.map(processMessage));
    } catch (err) {
      console.log("❌ SQS consumer error: " + err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
};

export { sendMessageToSqs, sqsEventConsumer };
