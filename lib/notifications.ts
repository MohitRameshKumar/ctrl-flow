import { RITUAL_NOTIFICATION_PREFIX, handleRitualNotificationButtonClicked } from './rituals';
import { SPACE_NOTIFICATION_PREFIX, handleSpaceNotificationButtonClicked } from './spaces';

/** Single entry point for chrome.notifications.onButtonClicked — routes by ID prefix. */
export async function routeNotificationButtonClicked(notificationId: string, buttonIndex: number): Promise<void> {
  if (notificationId.startsWith(RITUAL_NOTIFICATION_PREFIX)) {
    await handleRitualNotificationButtonClicked(notificationId);
    return;
  }
  if (notificationId.startsWith(SPACE_NOTIFICATION_PREFIX)) {
    await handleSpaceNotificationButtonClicked(notificationId, buttonIndex);
  }
}
