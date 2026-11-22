import { describe, expect, it } from 'vitest';
import { toolListVersion } from './coerce.ts';

const list = {
  name: 'events_list',
  description: 'List events.',
  inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } },
};
const create = {
  name: 'events_create',
  description: 'Log an event.',
  inputSchema: {
    type: 'object',
    properties: { atSec: { type: 'number' }, category: { type: 'string' } },
    required: ['category'],
  },
};

describe('toolListVersion', () => {
  it('is a stable 8-hex hash, independent of tool and key order', () => {
    const v = toolListVersion([list, create]);
    expect(v).toMatch(/^[0-9a-f]{8}$/);
    expect(toolListVersion([list, create])).toBe(v);
    const reordered = {
      ...create,
      inputSchema: {
        required: ['category'],
        properties: { category: { type: 'string' }, atSec: { type: 'number' } },
        type: 'object',
      },
    };
    expect(toolListVersion([reordered, list])).toBe(v);
  });

  it('changes when a schema, a description or the set of tools changes', () => {
    const v = toolListVersion([list, create]);
    const newOption = {
      ...create,
      inputSchema: {
        ...create.inputSchema,
        properties: { ...create.inputSchema.properties, compact: { type: 'boolean' } },
      },
    };
    expect(toolListVersion([list, newOption])).not.toBe(v);
    const reworded = { ...list, description: 'List the events of a session.' };
    expect(toolListVersion([reworded, create])).not.toBe(v);
    expect(toolListVersion([list])).not.toBe(v);
  });
});
