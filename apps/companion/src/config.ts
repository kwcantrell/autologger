import { Regex, type SomeCompanionConfigField } from '@companion-module/base';

export interface ModuleConfig {
  url: string;
}

/** Kept in Companion's secrets store, not the config store. */
export interface ModuleSecrets {
  token?: string;
}

export function getConfigFields(): SomeCompanionConfigField[] {
  return [
    {
      type: 'static-text',
      id: 'info',
      label: 'Setup',
      width: 12,
      value:
        'In AutoLogger open Settings → Companion devices, create a device for your show and paste its URL and token here.',
    },
    {
      type: 'textinput',
      id: 'url',
      label: 'AutoLogger server URL',
      tooltip: 'The address you open AutoLogger at, e.g. https://autologger.example.com',
      width: 8,
      default: 'http://127.0.0.1:8787',
      regex: Regex.SOMETHING,
    },
    {
      type: 'secret-text',
      id: 'token',
      label: 'Device token',
      tooltip: 'Starts with ald_ — shown once when you create the device',
      width: 8,
      default: '',
    },
  ];
}
