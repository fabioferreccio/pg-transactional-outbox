/**
 * Notification Listener Interface
 *
 * Abstracts the mechanism for listening to database notifications (e.g., LISTEN/NOTIFY).
 * This allows the NotifyRelay to be decoupled from the specific driver implementation.
 */
export interface NotificationListener {
  connect(): Promise<void>;
  listen(channel: string, onNotify: (payload?: string) => void): Promise<void>;
  unlisten(channel: string): Promise<void>;
  close(): Promise<void>;
}
