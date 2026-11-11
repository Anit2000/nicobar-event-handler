import mongoose from "mongoose";

const ProcessedOrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  shop: { type: String, required: true },
  processedAt: { type: Date, default: Date.now, expires: "7d" },
});

const ProcessedOrderModel = mongoose.model("processed_orders", ProcessedOrderSchema);

export default ProcessedOrderModel;
