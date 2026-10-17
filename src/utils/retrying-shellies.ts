import { Logger } from 'homebridge';
import {
  DeviceId,
  DeviceIdentifiers,
  DeviceOptions,
  RpcHandler,
  Shellies,
  ShelliesOptions,
  WebSocketRpcHandler,
} from 'shellies-ds9';

/**
 * Destroys an RPC handler that no device is going to use.
 * @param handler - The handler to destroy.
 */
export async function discardRpcHandler(handler: RpcHandler) {
  if (handler instanceof WebSocketRpcHandler) {
    // closing a socket that is still connecting counts as an abnormal closure, which makes the
    // handler schedule a reconnect and open a new socket that nothing will ever close
    handler.options.reconnectInterval = [];
  }

  await handler.destroy();
}

/**
 * A version of `Shellies` that retries devices that fail to be added.
 *
 * `Shellies` gives up on a discovered device after a single failed attempt, and only tries again if a
 * discoverer happens to emit the device again. Devices that time out while the network is still coming
 * up (e.g. when the host reboots after a power cut) could therefore stay unavailable until Homebridge
 * was restarted. Failed attempts are retried here using the configured websocket reconnect intervals.
 */
export class RetryingShellies extends Shellies {
  /**
   * RPC handlers created for devices that are currently being added.
   */
  protected readonly attemptHandlers: Map<DeviceId, RpcHandler> = new Map();

  /**
   * Scheduled retries, along with the number of failed attempts so far.
   */
  protected readonly retries: Map<DeviceId, { timeout: ReturnType<typeof setTimeout>; failures: number }> = new Map();

  /**
   * @param opts - A set of configuration options.
   * @param log - Used to log scheduled retries.
   */
  constructor(opts: Partial<ShelliesOptions>, readonly log: Logger) {
    super(opts);
  }

  protected createRpcHandler(identifiers: DeviceIdentifiers, options: DeviceOptions): RpcHandler {
    const handler = super.createRpcHandler(identifiers, options);
    // keep a reference so that it can be destroyed if the device isn't added
    this.attemptHandlers.set(identifiers.deviceId, handler);
    return handler;
  }

  protected async handleDiscoveredDevice(identifiers: DeviceIdentifiers) {
    const deviceId = identifiers.deviceId;

    if (this.devices.has(deviceId) || this.pendingDevices.has(deviceId) || this.ignoredDevices.has(deviceId)) {
      // this device has already been added, is being added or has been ignored
      return;
    }

    // this attempt replaces any scheduled retry
    const retry = this.retries.get(deviceId);
    if (retry !== undefined) {
      clearTimeout(retry.timeout);
      this.retries.delete(deviceId);
    }

    await super.handleDiscoveredDevice(identifiers);

    const handler = this.attemptHandlers.get(deviceId);
    this.attemptHandlers.delete(deviceId);

    if (this.devices.has(deviceId)) {
      return;
    }

    // the device wasn't added (it failed, or turned out to be excluded or unknown), so close its connection
    if (handler !== undefined) {
      try {
        await discardRpcHandler(handler);
      } catch (e) {
        this.log.debug(`[${deviceId}] Failed to close connection:`, e instanceof Error ? e.message : e);
      }
    }

    if (!this.ignoredDevices.has(deviceId)) {
      this.scheduleRetry(identifiers, (retry?.failures ?? 0) + 1);
    }
  }

  /**
   * Schedules another attempt at adding a device, after the reconnect interval for the given number of failures.
   * @param identifiers - The device identifiers.
   * @param failures - The number of failed attempts so far.
   */
  protected scheduleRetry(identifiers: DeviceIdentifiers, failures: number) {
    const reconnectInterval = this.options.websocket?.reconnectInterval ?? [];
    const intervals = Array.isArray(reconnectInterval) ? reconnectInterval : [reconnectInterval];
    const delay = (intervals[Math.min(failures, intervals.length) - 1] ?? 0) * 1000;

    // a non-positive interval means no more attempts
    if (delay <= 0) {
      return;
    }

    this.log.info(
      `[${identifiers.deviceId}] Retrying in ` +
      (delay < 60 * 1000 ? Math.floor(delay / 1000) + ' second(s)' : Math.floor(delay / (60 * 1000)) + ' minute(s)'),
    );

    const timeout = setTimeout(() => this.handleDiscoveredDevice(identifiers), delay);
    this.retries.set(identifiers.deviceId, { timeout, failures });
  }
}
