import * as xb from 'xrblocks';
import 'xrblocks/addons/simulator/SimulatorAddons.js';
import {enableNet, JoinRoomOptions, NetCore} from 'netblocks';

/**
 * Base class for netblocks samples. Wires up an xrblocks app and joins a
 * room via `xb.enableNet()`. Subclasses implement `getJoinOptions()` to
 * choose a transport and `onSession(session)` to attach app-level
 * listeners. The frame loop is driven by xrblocks itself — there's no
 * `update()` to override.
 */
export abstract class NetSample extends xb.Script {
  net!: NetCore;

  /** Return the room name + transport. Called once during `init`. */
  protected abstract getJoinOptions(): {
    roomId: string;
    options: JoinRoomOptions;
  };

  /** Called after `joinRoom` resolves. Override to attach handlers. */
  protected onSession(_session: NonNullable<NetCore['session']>): void {}

  async init() {
    this.net = enableNet();
    const {roomId, options} = this.getJoinOptions();
    try {
      const session = await this.net.joinRoom(roomId, options);
      this.onSession(session);
    } catch (err) {
      console.error('[netblocks/sample] failed to join room:', err);
    }
  }

  static run<T extends NetSample>(ctor: new () => T) {
    document.addEventListener('DOMContentLoaded', async () => {
      const options = new xb.Options();
      options.enableUI();
      options.reticles.enabled = true;
      options.controllers.visualizeRays = false;
      options.simulator.instructions.enabled = false;
      const app = new ctor();
      xb.add(app);
      await xb.init(options);
    });
  }
}
