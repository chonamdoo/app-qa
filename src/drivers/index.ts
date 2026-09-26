// Drivers module public API.
import type { Driver, Platform } from '../core/types.ts';
import { AndroidDriver } from './android.ts';
import type { DriverOptions } from './base.ts';
import { DesktopWebDriver } from './desktop.ts';
import { IosDriver } from './ios.ts';

export { ensureAppium, stopAppium } from '../appium/server.ts';
export { desktopBrowserChecks } from '../appium/setup.ts';
export { listApps, type AppInfo } from './apps.ts';
export { backupApp, findBackup, type BackupResult } from './backup.ts';
export type { DriverOptions, Key, LaunchOptions, PermissionState } from './base.ts';
export { androidChromeChecks, iosSafariChecks, prepareAndroidChrome } from './browser-prep.ts';
export { listDevices, pickDevice } from './devices.ts';
export { acquireDeviceLock, DeviceLockedError, type DeviceLock } from './lock.ts';
export { grabScreen, startRecording, stopRecording } from './screen.ts';

/** Creates a driver for a device (desktop: the browser platform id); the session opens on `driver.open(app)`. */
export function createDriver(platform: Platform, deviceId: string, opts: DriverOptions = {}): Driver {
  switch (platform) {
    case 'android':
      return new AndroidDriver(deviceId, opts);
    case 'ios':
      return new IosDriver(deviceId, opts);
    case 'desktop-chrome':
    case 'desktop-safari':
      return new DesktopWebDriver(platform, deviceId, opts);
  }
}
