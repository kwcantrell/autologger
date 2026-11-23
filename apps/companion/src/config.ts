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
        'In AutoLogger open Settings → Companion devices, create a device for your show and paste its token here. ' +
        'The server URL is the address you open AutoLogger at in your browser, e.g. https://autologger.example.com ' +
        '(for a local dev stack, http://localhost:5173).',
    },
    {
      type: 'textinput',
      id: 'url',
      label: 'AutoLogger server URL',
      tooltip:
        'The address you open AutoLogger at, e.g. https://autologger.example.com or http://localhost:5173',
      width: 8,
      default: '',
      required: true,
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
