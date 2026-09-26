// Drivers module public API.
import type { Driver, Platform } from '../core/types.ts';
import { AndroidDriver } from './android.ts';
import type { DriverOptions } from './base.ts';
import { IosDriver } from './ios.ts';

export { ensureAppium, stopAppium } from '../appium/server.ts';
export { listApps, type AppInfo } from './apps.ts';
export { backupApp, findBackup, type BackupResult } from './backup.ts';
export type { DriverOptions, Key, LaunchOptions, PermissionState } from './base.ts';
export { listDevices, pickDevice } from './devices.ts';
export { acquireDeviceLock, DeviceLockedError, type DeviceLock } from './lock.ts';
export { grabScreen, startRecording, stopRecording } from './screen.ts';

/** Creates a driver for a device; the Appium session opens on `driver.open(app)`. */
export function createDriver(platform: Platform, deviceId: string, opts: DriverOptions = {}): Driver {
  return platform === 'android' ? new AndroidDriver(deviceId, opts) : new IosDriver(deviceId, opts);
}
