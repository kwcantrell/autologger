import {
  InstanceBase,
  InstanceStatus,
  runEntrypoint,
  type SomeCompanionConfigField,
} from '@companion-module/base';
import { actionDefinitions } from './actions.js';
import { getConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js';
import { CompanionConnection, type ConnectionStatus } from './connection.js';
import { feedbackDefinitions } from './feedbacks.js';
import { presetDefinitions } from './presets.js';
import {
  type CompanionState,
  type LiveState,
  liveState,
  socketUrl,
  timecodeAt,
  toVariableValues,
} from './state.js';
import { UpgradeScripts } from './upgrades.js';
import { variableDefinitions } from './variables.js';

const TICK_MS = 100;

/** Category ids + names + kinds/options: when this changes, actions and presets are rebuilt. */
function categoriesKey(s: CompanionState | null): string {
  return JSON.stringify(
    s?.categories.map((c) => [
      c.id,
      c.name,
      c.position,
      c.kind,
      c.options,
      c.onLabel,
      c.offLabel,
    ]) ?? [],
  );
}

class AutologgerInstance extends InstanceBase<ModuleConfig, ModuleSecrets> {
  private config: ModuleConfig = { url: '' };
  private token = '';
  private conn: CompanionConnection | null = null;
  private live: LiveState | null = null;
  private catKey = '';
  private ticker: NodeJS.Timeout | null = null;
  private lastTimecode = '';

  async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
    this.setVariableDefinitions(variableDefinitions());
    this.setFeedbackDefinitions(feedbackDefinitions(() => this.live?.state ?? null));
    this.rebuildDynamic();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    await this.configUpdated(config, secrets);
  }

  async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
    this.config = config;
    this.token = (secrets?.token ?? '').trim();
    this.conn?.stop();
    this.conn = null;
    this.applyState(null);
    if (!this.config.url?.trim())
      return this.updateStatus(InstanceStatus.BadConfig, 'Enter the AutoLogger server URL');
    if (!this.token)
      return this.updateStatus(
        InstanceStatus.BadConfig,
        'Paste a device token (Settings → Companion devices)',
      );
    let url: string;
    try {
      url = socketUrl(this.config.url);
    } catch {
      return this.updateStatus(InstanceStatus.BadConfig, 'Server URL is not valid');
    }
    this.conn = new CompanionConnection(url, this.token, {
      onState: (state, serverTime) => this.applyState(liveState(state, serverTime, Date.now())),
      onStatus: (status, message) => this.applyStatus(status, message),
      onLog: (level, message) => this.log(level, message),
    });
    this.conn.start();
  }

  async destroy(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.conn?.stop();
    this.conn = null;
  }

  getConfigFields(): SomeCompanionConfigField[] {
    return getConfigFields();
  }

  private applyStatus(status: ConnectionStatus, message?: string): void {
    switch (status) {
      case 'ok':
        this.updateStatus(InstanceStatus.Ok);
        break;
      case 'connecting':
        this.updateStatus(InstanceStatus.Connecting);
        break;
      case 'bad_token':
        this.applyState(null);
        this.updateStatus(
          InstanceStatus.AuthenticationFailure,
          `${message ?? 'Device token rejected'}: create a new device in AutoLogger Settings → Companion devices`,
        );
        break;
      case 'error':
        this.updateStatus(InstanceStatus.ConnectionFailure, message ?? 'Cannot reach AutoLogger');
        break;
    }
  }

  private applyState(live: LiveState | null): void {
    this.live = live;
    const now = Date.now();
    const values = toVariableValues(live, now);
    this.lastTimecode = String(values.timecode);
    this.setVariableValues(values);
    this.checkFeedbacks('rolling', 'no_session', 'category_color');
    const key = categoriesKey(live?.state ?? null);
    if (key !== this.catKey) {
      this.catKey = key;
      this.rebuildDynamic();
    }
  }

  private rebuildDynamic(): void {
    const state = () => this.live?.state ?? null;
    this.setActionDefinitions(
      actionDefinitions({
        state,
        request: (op, input) => {
          if (!this.conn) return Promise.reject(new Error('Not configured'));
          return this.conn.request(op, input);
        },
        log: (level, msg) => this.log(level, msg),
        parseVariablesInString: (t) => this.parseVariablesInString(t),
      }),
    );
    this.setPresetDefinitions(presetDefinitions(state()));
  }

  /** Keep the timecode variable running between server pushes. */
  private tick(): void {
    if (!this.live?.state.session?.isRolling) return;
    const tc = timecodeAt(this.live, Date.now());
    if (tc === this.lastTimecode) return;
    this.lastTimecode = tc;
    this.setVariableValues({ timecode: tc });
  }
}

runEntrypoint(AutologgerInstance, UpgradeScripts);
