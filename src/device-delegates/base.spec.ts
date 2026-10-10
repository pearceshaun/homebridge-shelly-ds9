import { AddressInfo } from 'net';
import { Device, WebSocketRpcHandler } from 'shellies-ds9';
import { WebSocketServer } from 'ws';

import { DeviceDelegate } from './base';
import { ShellyPlatform } from '../platform';
import { DeviceOptions } from '../config';

class TestDelegate extends DeviceDelegate {
  protected setup() {
    // no accessories needed
  }
}

describe('DeviceDelegate reconnects', () => {
  let server: WebSocketServer;
  let handler: WebSocketRpcHandler;
  let delegate: TestDelegate;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise(resolve => server.once('listening', resolve));

    // a rebooting device closes its first connection with a normal closure and 'Bye'
    let count = 0;
    server.on('connection', ws => {
      if (++count === 1) {
        ws.close(1000, 'Bye');
      }
    });
  });

  afterEach(async () => {
    delegate.detach();
    await handler.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  it('reconnects after the device closes the connection with code 1000', async () => {
    const { port } = server.address() as AddressInfo;
    handler = new WebSocketRpcHandler(`127.0.0.1:${port}`, {
      clientId: 'test',
      requestTimeout: 10,
      pingInterval: 60,
      reconnectInterval: [0.1],
    });

    const device = { id: 'test-device', rpcHandler: handler } as unknown as Device;
    const platform = { log: { log: jest.fn() } } as unknown as ShellyPlatform;
    delegate = new TestDelegate(device, {} as DeviceOptions, platform);

    // wait until the client side has connected a second time
    await new Promise<void>(resolve => {
      let connects = 0;
      handler.on('connect', () => {
        if (++connects === 2) {
          resolve();
        }
      });
    });
  }, 5000);
});
