// The store module: where every house's records and files live. See docs/ARCHITECTURE.md ("store").
//   openLocalStore / createLocalWorkspace / listLocalWorkspaces  JSON files on this computer (local.js)
//   createCloud                                                 sign-in, houses, invites, lease (cloud.js)
//   openCloudStore                                              the same Store, synced through Supabase (cloud-store.js)
export { createLocalWorkspace, listLocalWorkspaces, openLocalStore, workspaceDir } from './local.js';
export { createCloud } from './cloud.js';
export { openCloudStore } from './cloud-store.js';
export { normalizeWorkspace } from './shared.js';
