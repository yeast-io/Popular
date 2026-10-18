import { Type, type Static } from '@sinclair/typebox';

export const DocsEntrySchema = Type.Object({ path: Type.String(), title: Type.String() });
export const DocsIndexSchema = Type.Object({ items: Type.Array(DocsEntrySchema) });
export const DocsDocumentSchema = Type.Object({ path: Type.String(), title: Type.String(), markdown: Type.String() });
export type DocsEntry = Static<typeof DocsEntrySchema>;
export type DocsIndex = Static<typeof DocsIndexSchema>;
export type DocsDocument = Static<typeof DocsDocumentSchema>;
