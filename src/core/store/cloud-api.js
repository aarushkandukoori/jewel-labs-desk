// The only code that talks to Supabase for the cloud store: the records table, the house row, Storage files and the
// Realtime feed. cloud-store.js calls these methods; its tests pass a fake object with the same methods instead.
// Every method throws an Error with .status and .retryable when it fails (see rows.js).
import { randomUUID } from 'node:crypto';
import { recordEventFromPayload, toCloudError, toStorageError } from './rows.js';
import { encodeFileKey } from './shared.js';

const PAGE_SIZE = 1000; // Supabase returns at most 1000 rows per request

/** The server calls the cloud store needs, on top of a supabase-js client (from createCloud). */
export function makeApi(client, workspaceId, { pageSize = PAGE_SIZE } = {}) {
  const bucket = () => client.storage.from('documents');
  const objectPath = (fileKey) => `${workspaceId}/${encodeFileKey(fileKey)}`;

  async function run(query) {
    const { data, error, status } = await query;
    if (error) throw toCloudError(error, status);
    return data;
  }

  // .retry(false): supabase-js would retry reads itself for about 7 s when offline. The store has its own retry
  // loop, and an offline open should fall back to the saved copy at once.
  return {
    loadWorkspace: () => run(client.from('workspaces').select('*').eq('id', workspaceId).maybeSingle().retry(false)),

    /**
     * Every record of the house, page by page in key order. Each page starts after the last row of the one before
     * (keyset paging), so rows saved meanwhile never make it skip one. It stops at an empty page rather than a
     * short one, because the server may return fewer rows per page than asked for (its own row limit).
     */
    async listRecords() {
      const rows = [];
      let after = { collection: '', id: '' };
      for (;;) {
        const page = await run(
          client.rpc('list_records', {
            p_workspace: workspaceId,
            p_after_collection: after.collection,
            p_after_id: after.id,
            p_limit: pageSize,
          }),
        );
        if (!page || page.length === 0) return rows;
        rows.push(...page);
        const last = page[page.length - 1];
        after = { collection: last.collection, id: last.id };
      }
    },

    getRecord: (collection, id) =>
      run(
        client
          .from('records')
          .select('workspace_id, collection, id, data, rev, updated_at')
          .eq('workspace_id', workspaceId)
          .eq('collection', collection)
          .eq('id', id)
          .maybeSingle()
          .retry(false),
      ),

    upsertRecords: (rows) =>
      run(
        client
          .from('records')
          .upsert(rows, { onConflict: 'workspace_id,collection,id' })
          .select('collection, id, rev, updated_at'),
      ),

    deleteRecord: (collection, id) =>
      run(client.from('records').delete().eq('workspace_id', workspaceId).eq('collection', collection).eq('id', id)),

    updateWorkspace: (patch) => run(client.rpc('update_house', { p_workspace: workspaceId, p_patch: patch })),

    async uploadFile(fileKey, bytes, mime) {
      const { error } = await bucket().upload(objectPath(fileKey), bytes, { contentType: mime, upsert: true });
      if (error) throw toStorageError(error);
    },

    async downloadFile(fileKey) {
      const { data, error } = await bucket().download(objectPath(fileKey));
      if (error) throw toStorageError(error);
      return new Uint8Array(await data.arrayBuffer());
    },

    async removeFile(fileKey) {
      const { error } = await bucket().remove([objectPath(fileKey)]);
      if (error) throw toStorageError(error);
    },

    /** Live changes for this house. onStatus gets 'SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT' or 'CLOSED'. */
    subscribe({ onRecord, onWorkspace, onStatus }) {
      // wait: true makes "SUBSCRIBED" mean the database changes feed is really running.
      const channel = client.channel(`house-${workspaceId}-${randomUUID().slice(0, 8)}`, {
        config: { postgres_changes_options: { wait: true } },
      });
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'records', filter: `workspace_id=eq.${workspaceId}` },
        (payload) => onRecord(recordEventFromPayload(payload)),
      );
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'workspaces', filter: `id=eq.${workspaceId}` },
        (payload) => onWorkspace(payload.new),
      );
      channel.subscribe((state, err) => onStatus(state, err));
      return {
        close: () => {
          client.removeChannel(channel);
        },
      };
    },
  };
}
