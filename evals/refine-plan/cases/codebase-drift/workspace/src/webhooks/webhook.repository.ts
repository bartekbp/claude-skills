import { db } from "../db";

export interface WebhookSubscription {
  id: string;
  url: string;
  secret: string;
  createdAt: Date;
}

export class WebhookRepository {
  async findSubscription(id: string): Promise<WebhookSubscription | null> {
    return db.webhook_subscriptions.findById(id);
  }

  async listSubscriptions(): Promise<WebhookSubscription[]> {
    return db.webhook_subscriptions.findAll();
  }
}
