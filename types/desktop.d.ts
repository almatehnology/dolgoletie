export type LocalFileKind = 'tables' | 'sync';

export interface DesktopSelectedFile {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  mimeType: string;
}

/** Only user-selected capabilities cross the bridge. No paths, generic IPC or Node API. */
export interface TravelDesktopBridge {
  readonly version: 1;
  selectFiles(options: { kind: LocalFileKind }): Promise<DesktopSelectedFile[] | null>;
  readFileChunk(id: string, offset: number): Promise<Uint8Array>;
  releaseFiles(ids: string[]): Promise<void>;
  beginSave(filename: string, size: number): Promise<{ id: string; chunkBytes: number } | null>;
  writeSaveChunk(id: string, offset: number, bytes: Uint8Array): Promise<number>;
  finishSave(id: string): Promise<boolean>;
  cancelSave(id: string): Promise<void>;
}

declare global {
  interface Window { readonly travelDesktop?: TravelDesktopBridge }
}
