import { CharacteristicValue } from 'homebridge';
import { CharacteristicValue as ShelliesCharacteristicValue, Light } from 'shellies-ds9';

import { Ability, ServiceClass } from './base';

export class LightAbility extends Ability {
  /**
   * @param component - The light component to control.
   */
  constructor(readonly component: Light) {
    super(
      `Light ${component.id + 1}`,
      `light-${component.id}`,
    );

  }

  protected get serviceClass(): ServiceClass {
    return this.Service.Lightbulb;
  }

  protected initialize() {
    // set the initial value
    this.service.setCharacteristic(
      this.Characteristic.On,
      this.component.output,
    );
    this.service.setCharacteristic(
      this.Characteristic.Brightness,
      this.component.brightness,
    );

    // listen for commands from HomeKit
    this.service.getCharacteristic(this.Characteristic.On)
      .onSet(this.onSetHandler.bind(this));
    this.service.getCharacteristic(this.Characteristic.Brightness)
      .onSet(this.brightnessSetHandler.bind(this));

    // listen for updates from the device
    this.component.on('change:output', this.outputChangeHandler, this);
    this.component.on('change:brightness', this.brightnessChangeHandler, this);
  }

  detach() {
    this.component.off('change:output', this.outputChangeHandler, this);
    this.component.off('change:brightness', this.brightnessChangeHandler, this);
  }

  /**
   * Handles changes to the Light.On characteristic.
   */
  protected async onSetHandler(value: CharacteristicValue) {
    if (value === this.component.output) {
      return;
    }

    try {
      await this.component.set(value as boolean);
    } catch (e) {
      this.log.error(
        'Failed to set light:',
        e instanceof Error ? e.message : e,
      );
      throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
    }
  }

  /**
   * Handles changes to the `output` property.
   */
  protected outputChangeHandler(value: ShelliesCharacteristicValue) {
    if (value){
      this.log.info('Light Status('+this.component.id+'): on');
    }else{
      this.log.info('Light Status('+this.component.id+'): off');
    }
    this.service.getCharacteristic(this.Characteristic.On)
      .updateValue(value as boolean);
  }

  /**
   * Handles changes to the Light.Brightness characteristic.
   */
  protected async brightnessSetHandler(value: CharacteristicValue) {
    if (value === this.component.brightness) {
      return;
    }

    try {
      await this.component.set(undefined, value as number);
    } catch (e) {
      this.log.error(
        'Failed to set light:',
        e instanceof Error ? e.message : e,
      );
      throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
    }
  }

  /**
   * Handles changes to the `brightness` property.
   */
  protected brightnessChangeHandler(value: ShelliesCharacteristicValue) {
    this.log.info('Light Status('+this.component.id+'): '+value);
    this.service.getCharacteristic(this.Characteristic.Brightness)
      .updateValue(value as number);
  }
}
