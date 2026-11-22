import type { CompanionStaticUpgradeScript } from '@companion-module/base';
import type { ModuleConfig, ModuleSecrets } from './config.js';

/** 3.0 is a fresh protocol; no automatic upgrades from the 0.x (long-poll) module. */
export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets | undefined>[] = [];
