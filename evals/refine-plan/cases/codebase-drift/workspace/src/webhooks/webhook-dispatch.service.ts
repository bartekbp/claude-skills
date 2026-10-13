import { WebhookRepository } from "./webhook.repository";
import { signPayload } from "./signing";
import { SubscriptionNotFoundError } from "../errors";

export class WebhookDispatchService {
  constructor(private readonly repository: WebhookRepository) {}

  async dispatch(subscriptionId: string, payload: unknown): Promise<void> {
    const subscription = await this.repository.findSubscription(subscriptionId);
    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }
    const signature = signPayload(subscription.secret, payload);
    await this.post(subscription.url, payload, signature);
  }

  private async post(url: string, payload: unknown, signature: string): Promise<void> {
    // POST with X-Webhook-Signature header; throws DeliveryFailedError on non-2xx
  }
}
