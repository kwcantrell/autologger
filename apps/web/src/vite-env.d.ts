/// <reference types="vite/client" />

declare module '*.webm' {
  const src: string;
  export default src;
}

/** The published docs pages (vite.config.ts docsPlugin). */
declare module 'virtual:docs' {
  export const pages: import('@/routes/docs/docsIndex').DocMeta[];
  /** One lazy loader per page path: the raw Markdown file, front matter included. */
  export const loaders: Record<string, () => Promise<{ default: string }>>;
}
