import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import * as Y from 'yjs'

import { RELAY_SERVER_PEER } from '@open-pencil/cloud/contract'
import { createYjsGraphSync } from '@open-pencil/collab'
import { exportFigFile, parseFigFile } from '@open-pencil/core/io/formats/fig'
import { SceneGraph } from '@open-pencil/scene-graph'

import { openCloudDocumentRoom } from '@/app/cloud/rooms/live'
import { collabEditor } from '@/app/collab/editor'
import { createEditorStore } from '@/app/editor/session'

import { startTestRelay } from '#tests/helpers/collab/relay-server'

async function until(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 300; attempts++) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error('Relay did not deliver the synchronization marker')
}

for (const mode of ['pending-peer', 'hydrated-peer', 'new-child'] as const) {
  test(`a ${mode} receives an authored nested lazy layer under its parent`, async () => {
    const template = new SceneGraph()
    const initial = template.getPages()[0]
    if (!initial) throw new Error('Missing first page')
    const marker = template.createNode('RECTANGLE', initial.id, { name: 'Initial marker' })
    const page = template.addPage('Lazy page')
    const frame = template.createNode('FRAME', page.id, { name: 'Lazy frame' })
    const layer = template.createNode('RECTANGLE', frame.id, { name: 'Original nested layer' })
    const top = template.createNode('RECTANGLE', page.id, { name: 'Original top layer' })
    const bytes = await exportFigFile(template)
    const open = () => parseFigFile(bytes.slice().buffer, { populate: 'first-page' })
    const seed = createEditorStore(await open())
    const doc = new Y.Doc()
    createYjsGraphSync({
      getEditor: () => collabEditor(seed),
      getYdoc: () => doc,
      getYnodes: () => doc.getMap('nodes'),
      getYimages: () => doc.getMap('images'),
      setSuppressYjsEvents: () => undefined
    }).syncAllNodesToYjs()
    const snapshot = Y.encodeStateAsUpdate(doc)
    seed.preparationController.dispose()
    doc.destroy()
    const relay = await startTestRelay()
    const documentId = crypto.randomUUID()
    const key = `${documentId}:0`
    relay.rooms.set(key, { snapshot, updates: [], sequence: 0 })
    const stores = [createEditorStore(await open()), createEditorStore(await open())]
    const [author, peer] = stores
    for (const store of stores) {
      store.onPreparationEvent('preparation:updated', (preparation) => {
        if (preparation.phase === 'preparing-render')
          store.preparationController.acknowledgePresentation(store.state)
      })
    }
    const rooms = stores.map((store, index) =>
      openCloudDocumentRoom(store, {
        roomId: `cloud:${key}`,
        transport: relay.join(documentId, ['Author', 'Peer'][index], 'edit', 'user'),
        permission: 'edit',
        uploadNow: async () => true
      })
    )
    const synced = new Set<number>()
    const stopWatching = rooms.map(({ session }, index) =>
      session.onSynced((peerId) => {
        if (peerId === RELAY_SERVER_PEER) synced.add(index)
      })
    )
    try {
      await until(
        () =>
          synced.size === rooms.length &&
          rooms.every(({ session }) => session.roomHasDocument() && session.hasDocument.value)
      )
      expect(author.graph.getNode(frame.id)).toBeUndefined()
      expect(peer.graph.getNode(frame.id)).toBeUndefined()
      if (mode === 'hydrated-peer') {
        await peer.switchPage(page.id)
        expect(peer.state.currentPageId).toBe(page.id)
        expect(peer.graph.getNode(layer.id)?.parentId).toBe(frame.id)
        peer.updateNode(marker.id, { name: 'Peer has opened the lazy page' })
        await until(() => author.graph.getNode(marker.id)?.name === 'Peer has opened the lazy page')
      }
      await author.switchPage(page.id)
      expect(author.state.currentPageId).toBe(page.id)
      expect(author.graph.getNode(layer.id)?.parentId).toBe(frame.id)
      const name = mode === 'new-child' ? 'New nested layer' : 'Edited nested layer'
      const changedId =
        mode === 'new-child'
          ? author.graph.createNode('RECTANGLE', frame.id, { name }).id
          : layer.id
      if (mode !== 'new-child') author.updateNode(layer.id, { name })
      author.updateNode(top.id, { name: 'Edited top layer' })
      author.updateNode(marker.id, { name: 'Batch received' })
      await until(() => peer.graph.getNode(marker.id)?.name === 'Batch received')
      expect(peer.graph.getNode(top.id)?.parentId).toBe(page.id)
      expect(peer.graph.getNode(top.id)?.name).toBe('Edited top layer')
      await peer.switchPage(page.id)
      expect(peer.state.currentPageId).toBe(page.id)
      expect(peer.graph.getNode(changedId)?.parentId).toBe(frame.id)
      const children = peer.graph.getChildren(frame.id).map(({ id, name }) => ({ id, name }))
      expect(children).toEqual(
        mode === 'new-child'
          ? [
              { id: layer.id, name: 'Original nested layer' },
              { id: changedId, name }
            ]
          : [{ id: changedId, name }]
      )
    } finally {
      for (const stop of stopWatching) stop()
      for (const room of rooms) {
        room.stop()
        room.session.dispose()
      }
      for (const store of stores) store.preparationController.dispose()
      await relay.close()
    }
  }, 60_000)
}
