// Declarative dashboard spec. Agents author it, the web renders it with its own components.
// Nothing in a spec is executed; markdown is rendered without raw HTML.

import { z } from 'zod';

const Row = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** Live queries over the session's own data, recomputed on every render. */
export const DashboardQuery = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('events_by_category'),
  }),
  z.object({
    name: z.literal('events_over_time'),
    bucketSec: z.number().int().min(10).max(3600).default(300),
    categories: z.array(z.string()).optional(),
  }),
  z.object({ name: z.literal('speaker_talk_time') }),
  z.object({
    name: z.literal('topics'),
    /** Only topics at this level or above: 1 = chapters only, 2 = chapters and sub-topics. */
    maxLevel: z.number().int().min(1).max(3).optional(),
  }),
  z.object({
    name: z.literal('events'),
    categories: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  z.object({ name: z.literal('summary_stats') }),
]);
export type DashboardQuery = z.infer<typeof DashboardQuery>;

const DataSource = {
  /** Static rows computed by the agent. */
  data: z.array(Row).max(1000).optional(),
  /** Or a live query. Exactly one of `data` / `query` must be present for data widgets. */
  query: DashboardQuery.optional(),
};

/**
 * How a numeric value is displayed: duration = seconds as H:MM:SS / M:SS, minutes = seconds as
 * minutes with one decimal, number = plain number, percent = a 0–1 ratio as a percentage.
 */
export const ValueFormat = z.enum(['duration', 'minutes', 'number', 'percent']);
export type ValueFormat = z.infer<typeof ValueFormat>;

const Base = {
  id: z.string().min(1).max(64),
  title: z.string().max(200).default(''),
  description: z.string().max(1000).optional(),
  /** Grid columns out of 4. */
  span: z.number().int().min(1).max(4).default(2),
};

export const Widget = z.discriminatedUnion('type', [
  z.object({
    ...Base,
    type: z.literal('stat'),
    value: z.union([z.string(), z.number()]).optional(),
    unit: z.string().max(20).optional(),
    caption: z.string().max(200).optional(),
    ...DataSource,
    field: z.string().optional(),
    format: ValueFormat.optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('bar'),
    ...DataSource,
    x: z.string(),
    y: z.string(),
    horizontal: z.boolean().default(false),
    /** Format of the value (y) axis and tooltip. */
    format: ValueFormat.optional(),
    /** Truncate category labels to this many characters (with …); the tooltip shows the full label. */
    labelMaxChars: z.number().int().min(4).max(200).optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('line'),
    ...DataSource,
    x: z.string(),
    y: z.string(),
    /** Format of the value (y) axis and tooltip. */
    format: ValueFormat.optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('pie'),
    ...DataSource,
    label: z.string(),
    value: z.string(),
  }),
  z.object({
    ...Base,
    type: z.literal('table'),
    ...DataSource,
    columns: z
      .array(z.object({ key: z.string(), label: z.string().optional() }))
      .max(12)
      .optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('timeline'),
    ...DataSource,
    /** Field holding session seconds. */
    at: z.string().default('atSec'),
    label: z.string().default('label'),
    duration: z.string().optional(),
  }),
  z.object({ ...Base, type: z.literal('markdown'), markdown: z.string().max(20000) }),
]);
export type Widget = z.infer<typeof Widget>;

export const DashboardSpec = z.object({
  version: z.literal(1).default(1),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  widgets: z.array(Widget).max(40),
});
export type DashboardSpec = z.infer<typeof DashboardSpec>;
export type DashboardSpecInput = z.input<typeof DashboardSpec>;
