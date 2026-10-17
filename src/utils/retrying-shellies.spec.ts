import { AddressInfo } from 'net';
import { Logger } from 'homebridge';
import { Device, DeviceDiscoverer, DeviceIdentifiers, WebSocketRpcHandler } from 'shellies-ds9';
import { WebSocketServer } from 'ws';

import { RetryingShellies, discardRpcHandler } from './retrying-shellies';

const DEVICE_ID = 'shellyplus1-083af2029608';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A fake Shelly device that answers `Shelly.GetDeviceInfo` with an error on its first `failures` connections.
 */
class FakeDevice {
  readonly server = new WebSocketServer({ port: 0 });
  connections = 0;
  closed = 0;

  constructor(failures: number, model = 'SNSW-001X16EU') {
    this.server.on('connection', ws => {
      const connection = ++this.connections;
      ws.on('close', () => this.closed++);
      ws.on('message', data => {
        const { id, method } = JSON.parse(data.toString());
        if (method === 'Shelly.GetDeviceInfo' && connection <= failures) {
          ws.send(JSON.stringify({ id, error: { code: -1, message: 'Not ready' } }));
        } else if (method === 'Shelly.GetDeviceInfo') {
          ws.send(JSON.stringify({ id, result: { id: DEVICE_ID, mac: '083AF2029608', model, gen: 2 } }));
        } else {
          ws.send(JSON.stringify({ id, result: {} }));
        }
      });
    });
  }

  get hostname() {
    return `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close() {
    return new Promise(resolve => this.server.close(resolve));
  }
}

/**
 * Emits devices on demand.
 */
class TestDiscoverer extends DeviceDiscoverer {
  discover(identifiers: DeviceIdentifiers) {
    this.handleDiscoveredDevice(identifiers);
  }
}

describe('RetryingShellies', () => {
  let fake: FakeDevice;
  let shellies: RetryingShellies;
  let log: Logger;
  let discoverer: TestDiscoverer;
  let added: Device[];

  const setup = async (failures: number, reconnectInterval: number[], model?: string) => {
    fake = new FakeDevice(failures, model);
    await new Promise(resolve => fake.server.once('listening', resolve));

    log = { info: jest.fn(), debug: jest.fn() } as unknown as Logger;
    shellies = new RetryingShellies({
      websocket: { clientId: 'test', requestTimeout: 1, pingInterval: 0, reconnectInterval },
      autoLoadStatus: true,
      autoLoadConfig: true,
    }, log);
    shellies.on('error', () => undefined);

    added = [];
    shellies.on('add', device => added.push(device));

    discoverer = new TestDiscoverer();
    shellies.registerDiscoverer(discoverer);
    discoverer.discover({ deviceId: DEVICE_ID, hostname: fake.hostname });
  };

  afterEach(async () => {
    for (const device of added) {
      await device.rpcHandler.destroy();
    }
    await fake.close();
  });

  it('retries a device that failed to be added, closing the failed connection', async () => {
    await setup(1, [0.05]);

    while (added.length === 0) {
      await sleep(10);
    }
    expect(added[0].id).toBe(DEVICE_ID);
    expect(log.info).toHaveBeenCalledWith(`[${DEVICE_ID}] Retrying in 0 second(s)`);

    // the first connection is closed and no other connections are made
    await sleep(200);
    expect(fake.connections).toBe(2);
    expect(fake.closed).toBe(1);
  });

  it('stops retrying when the reconnect intervals say so', async () => {
    await setup(Infinity, [0.05, 0]);

    await sleep(300);
    expect(added).toHaveLength(0);
    expect(fake.connections).toBe(2);
    expect(fake.closed).toBe(2);
  });

  it('does not retry an unknown device, and closes its connection', async () => {
    const unknown = jest.fn();
    await setup(0, [0.05], 'S4SW-001X8EU');
    shellies.on('unknown', unknown);

    await sleep(300);
    expect(unknown).toHaveBeenCalledWith(DEVICE_ID, 'S4SW-001X8EU', expect.anything());
    expect(log.info).not.toHaveBeenCalled();
    expect(fake.connections).toBe(1);
    expect(fake.closed).toBe(1);
  });
});

describe('discardRpcHandler', () => {
  it('does not reconnect a socket that is still connecting', async () => {
    // a device that doesn't complete the WebSocket handshake until told to
    const handshakes: ((result: boolean) => void)[] = [];
    const server = new WebSocketServer({
      port: 0,
      verifyClient: (_info, callback) => {
        handshakes.push(callback);
      },
    });
    await new Promise(resolve => server.once('listening', resolve));

    const handler = new WebSocketRpcHandler(`127.0.0.1:${(server.address() as AddressInfo).port}`, {
      clientId: 'test',
      requestTimeout: 1,
      pingInterval: 0,
      reconnectInterval: [0.05],
    });
    handler.on('error', () => undefined);

    while (handshakes.length === 0) {
      await sleep(10);
    }
    await discardRpcHandler(handler);

    await sleep(200);
    expect(handshakes).toHaveLength(1);

    handshakes.forEach(callback => callback(false));
    await new Promise(resolve => server.close(resolve));
  });
});
