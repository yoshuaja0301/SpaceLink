/**
 * File System Access API declarations the bundled DOM lib is missing.
 *
 * `lib.dom.d.ts` (TypeScript 5.9) declares `FileSystemHandle`,
 * `FileSystemFileHandle`, `FileSystemDirectoryHandle` and
 * `FileSystemWritableFileStream`, but not:
 *
 * - the async iteration helpers on a directory handle (those live in
 *   `lib.dom.asynciterable.d.ts`, which this project does not enable), and
 * - the permission API (`queryPermission` / `requestPermission`), which is not
 *   in the DOM lib at all.
 *
 * Both are declared here through interface merging. `showDirectoryPicker` is
 * deliberately *not* declared globally: it exists only in Chromium browsers, so
 * `directoryVault.ts` feature-detects it on `globalThis` instead.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemHandle {
  /** Chromium only; absent in browsers that ship the API without permissions. */
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>
  keys(): AsyncIterableIterator<string>
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>
}

interface DirectoryPickerOptions {
  /** Groups picker sessions so the browser reopens the last used folder. */
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
}
