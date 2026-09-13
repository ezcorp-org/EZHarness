import type { FactoryPrincipal } from "./grants";
import type { FactoryNotification, FactoryNotificationListOptions, FactoryNotificationPage, FactoryReleases } from "./releases";

/** Delivers the existing release outbox into its durable, current-authorized in-app view. */
export class FactoryNotificationDelivery {
  readonly tenantId: string;

  constructor(private readonly releases: FactoryReleases) {
    this.tenantId = releases.tenantId;
  }

  deliverNext(projectId: string): Promise<FactoryNotification | null> {
    return this.releases.deliverNextNotification(projectId);
  }

  listForHuman(actor: FactoryPrincipal, projectId: string, options?: FactoryNotificationListOptions): Promise<FactoryNotificationPage> {
    return this.releases.listDeliveredNotifications(actor, projectId, options);
  }
}
