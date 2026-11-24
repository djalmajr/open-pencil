import 'fake-indexeddb/auto'
import { afterEach, expect, test } from 'bun:test'

import * as Y from 'yjs'

import { createYjsGraphSync } from '@open-pencil/collab'
import { exportFigFile, parseFigFile } from '@open-pencil/core/io/formats/fig'
import { figCheckpointRecords } from '@open-pencil/fig'
import { initCodec } from '@open-pencil/kiwi/fig/codec'
import { heavy } from '@open-pencil/test-support/heavy'
import { readFixtureArrayBuffer } from '@open-pencil/test-support/paths'

import { openCloudDocumentRoom } from '@/app/cloud/rooms/live'
import { collabEditor } from '@/app/collab/editor'
import { setRecoveryRuntimeOverride } from '@/app/document/recovery/preferences'
import { createEditorStore } from '@/app/editor/session'

import { releaseFigPopulationWorker } from '#core/kiwi/fig/population/client'
import { figArchive, releaseFigArchive } from '#core/kiwi/fig/session/archive/access'
import {
  hasPendingReaderPages,
  isReaderPagePending,
  readerCheckpoint
} from '#core/kiwi/fig/session/document-state'

import { startTestRelay } from '#tests/helpers/collab/relay-server'

const fixture = () => readFixtureArrayBuffer('gold-preview.fig')
const cleanup: (() => Promise<void> | void)[] = []

function roomSnapshotFromGraph(graph: Awaited<ReturnType<typeof parseFigFile>>): Uint8Array {
  const seedStore = createEditorStore(graph)
  const ydoc = new Y.Doc()
  const ynodes = ydoc.getMap<Y.Map<unknown>>('nodes')
  const yimages = ydoc.getMap<Uint8Array>('images')
  const editor = collabEditor(seedStore)
  const sync = createYjsGraphSync({
    getEditor: () => editor,
    getYdoc: () => ydoc,
    getYnodes: () => ynodes,
    getYimages: () => yimages,
    setSuppressYjsEvents: () => undefined
  })
  sync.syncAllNodesToYjs()
  const snapshot = Y.encodeStateAsUpdate(ydoc)
  seedStore.preparationController.dispose()
  ydoc.destroy()
  return snapshot
}

async function fixtureRoomSnapshot(): Promise<Uint8Array> {
  const graph = await parseFigFile(fixture())
  return roomSnapshotFromGraph(graph)
}

async function until(condition: () => boolean, attempts = 1500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error('condition was not met')
}

async function pendingComponentUse(graph: Awaited<ReturnType<typeof parseFigFile>>) {
  const archive = figArchive(graph)
  const checkpoint = readerCheckpoint(graph)
  if (!archive || !checkpoint) throw new Error('fixture has no reader archive')
  const byGuid = figCheckpointRecords(checkpoint)
  const byNode = new Map([...byGuid].map(([guid, id]) => [id, guid]))
  for (const node of graph.getAllNodes()) {
    if (node.type !== 'COMPONENT') continue
    const guid = byNode.get(node.id)
    if (!guid) continue
    for (const pageGuid of await archive.componentPages([guid])) {
      const pageId = byGuid.get(pageGuid)
      if (pageId !== undefined && isReaderPagePending(graph, pageId)) return { node, pageId }
    }
  }
  throw new Error('fixture has no pending component-use page')
}

async function openFixtureRoom(documentId: string, snapshot: Uint8Array) {
  const roomKey = `${documentId}:0`
  const relay = await startTestRelay()
  cleanup.push(() => relay.close())
  relay.rooms.set(roomKey, { snapshot, updates: [], sequence: 0 })

  const first = createEditorStore(await parseFigFile(fixture()))
  const second = createEditorStore(await parseFigFile(fixture()))
  cleanup.push(() => {
    releaseFigPopulationWorker(first.graph)
    first.preparationController.dispose()
  })
  cleanup.push(() => {
    releaseFigPopulationWorker(second.graph)
    second.preparationController.dispose()
  })
  const firstRoom = openCloudDocumentRoom(first, {
    roomId: `cloud:${roomKey}`,
    transport: relay.join(documentId, 'Grace', 'edit', 'user'),
    permission: 'edit'
  })
  const secondRoom = openCloudDocumentRoom(second, {
    roomId: `cloud:${roomKey}`,
    transport: relay.join(documentId, 'Ada', 'edit', 'user'),
    permission: 'edit'
  })
  cleanup.push(() => {
    firstRoom.stop()
    firstRoom.session.dispose()
  })
  cleanup.push(() => {
    secondRoom.stop()
    secondRoom.session.dispose()
  })
  await until(() => firstRoom.session.hasDocument.value && secondRoom.session.hasDocument.value)
  return { relay, roomKey, first, second }
}

afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop()
})

heavy('export isolation with the gold fixture', () => {
  test('recovery export keeps the live partially-loaded graph isolated and round-trips', async () => {
    await initCodec()
    const graph = await parseFigFile(fixture())
    cleanup.push(() => releaseFigPopulationWorker(graph))
    expect([...graph.getAllNodes()]).toHaveLength(2357)
    expect(hasPendingReaderPages(graph)).toBe(true)

    const { node: component } = await pendingComponentUse(graph)
    graph.updateNode(component.id, { name: 'INF37 isolated export edit' })
    const componentSource = structuredClone(component.source)
    const beforeNodes = structuredClone([...graph.nodes])
    const beforeVariables = structuredClone([...graph.variables])
    const beforeCollections = structuredClone([...graph.variableCollections])
    const beforeImages = [...graph.images].map(([name, bytes]) => [name, bytes.slice()] as const)

    const exported = await exportFigFile(graph)

    expect([...graph.getAllNodes()]).toHaveLength(2357)
    expect([...graph.nodes]).toEqual(beforeNodes)
    expect([...graph.variables]).toEqual(beforeVariables)
    expect([...graph.variableCollections]).toEqual(beforeCollections)
    expect([...graph.images].map(([name, bytes]) => [name, bytes] as const)).toEqual(beforeImages)
    expect(hasPendingReaderPages(graph)).toBe(true)
    expect(exported.byteLength).toBeGreaterThan(0)

    const reopened = await parseFigFile(exported.slice().buffer)
    cleanup.push(() => releaseFigPopulationWorker(reopened))
    expect(
      [...reopened.getAllNodes()].some((node) => node.name === 'INF37 isolated export edit')
    ).toBe(true)
    const reopenedSource = reopened.getNode(component.id)?.source
    expect(reopenedSource?.id).toBe(componentSource.id)
    expect(reopenedSource?.format).toBe(componentSource.format)
    expect(reopenedSource?.fig).toEqual(componentSource.fig)
    const variable = graph.variables.values().next().value
    if (!variable) throw new Error('fixture has no variable')
    expect(reopened.variables.get(variable.id)).toMatchObject({
      id: variable.id,
      name: variable.name,
      type: variable.type,
      valuesByMode: variable.valuesByMode
    })
    const collection = graph.variableCollections.values().next().value
    if (!collection) throw new Error('fixture has no variable collection')
    expect(reopened.variableCollections.get(collection.id)).toMatchObject({
      id: collection.id,
      name: collection.name,
      modes: collection.modes
    })
    for (const [name, bytes] of beforeImages) expect(reopened.images.get(name)).toEqual(bytes)
  }, 60_000)

  test.each(['incremental', 'full'] as const)(
    '%s export leaves the room graph unchanged and sends no materialization updates',
    async (mode) => {
      setRecoveryRuntimeOverride(false)
      cleanup.push(() => setRecoveryRuntimeOverride(null))
      await initCodec()
      const { relay, roomKey, first, second } = await openFixtureRoom(
        crypto.randomUUID(),
        await fixtureRoomSnapshot()
      )
      const edited = [...first.graph.getAllNodes()].find((node) => node.type === 'TEXT')
      if (!edited) throw new Error('fixture has no text node')
      const { node: component } = await pendingComponentUse(first.graph)
      const room = relay.rooms.get(roomKey)
      if (!room?.snapshot) throw new Error('missing relay room snapshot')
      const persisted = new Y.Doc()
      cleanup.push(() => persisted.destroy())
      Y.applyUpdate(persisted, room.snapshot)
      let applied = 0
      const persistedName = (id: string) => {
        while (applied < room.updates.length) Y.applyUpdate(persisted, room.updates[applied++])
        return persisted.getMap<Y.Map<unknown>>('nodes').get(id)?.get('name')
      }
      first.graph.updateNode(component.id, { name: 'INF37 component edit' })
      await until(() => second.graph.getNode(component.id)?.name === 'INF37 component edit')
      await until(() => persistedName(component.id) === 'INF37 component edit')
      const persistedNodes = persisted.getMap<Y.Map<unknown>>('nodes')
      const beforePersistedIds = new Set(persistedNodes.keys())
      const addedIds = new Set<string>()
      const observeNodes = (event: Y.YMapEvent<Y.Map<unknown>>) => {
        for (const [id, change] of event.changes.keys)
          if (change.action === 'add' && !beforePersistedIds.has(id)) addedIds.add(id)
      }
      persistedNodes.observe(observeNodes)
      cleanup.push(() => persistedNodes.unobserve(observeNodes))
      const beforeNodes = [...first.graph.nodes.keys()]
      expect(beforeNodes).toHaveLength(2357)
      expect(hasPendingReaderPages(first.graph)).toBe(true)

      // Exercise both the incremental writer and the whole-file fallback.
      if (mode === 'full') releaseFigArchive(first.graph)
      const exported = await exportFigFile(first.graph)
      expect(exported.byteLength).toBeGreaterThan(0)
      expect(first.graph.nodes.size).toBe(2357)
      expect([...first.graph.nodes.keys()]).toEqual(beforeNodes)
      expect(hasPendingReaderPages(first.graph)).toBe(true)

      first.graph.updateNode(edited.id, { name: 'INF37 after export' })
      await until(() => second.graph.getNode(edited.id)?.name === 'INF37 after export')
      await until(() => persistedName(edited.id) === 'INF37 after export')
      expect([...second.graph.getAllNodes()]).toHaveLength(2357)
      const afterPersistedIds = new Set(persistedNodes.keys())
      expect(addedIds.size).toBe(0)
      expect([...afterPersistedIds].filter((id) => !beforePersistedIds.has(id)).length).toBe(0)
      expect([...beforePersistedIds].filter((id) => !afterPersistedIds.has(id))).toEqual([])
    },
    60_000
  )
})
