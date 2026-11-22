import { desktopBridge, type UpdateState } from './electronBridge';

/**
 * The two bridge calls an update can make, in one place.
 *
 * The automatic prompt and the manual badge/Settings buttons both reach the same IPC channels. Keeping
 * the calls here means a new caller cannot invent a third way to download or install, and the unsigned
 * decision is derived from what the main process actually reported rather than from a UI guess.
 */
export async function runUpdateDownload(): Promise<UpdateState | undefined> {
  const bridge = desktopBridge();
  return bridge ? bridge.updates.download() : undefined;
}

export async function runUpdateInstall(state: UpdateState | undefined): Promise<void> {
  const bridge = desktopBridge();
  if (!bridge) return;
  await bridge.updates.install({ allowUnsigned: state?.signed === false });
}
