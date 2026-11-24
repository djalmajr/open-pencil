import { expect, test } from 'bun:test'

import { encodeArchive, open } from '#core-tests/helpers/fig/archive'
import { layerNamed, pageNamed, recordsOf } from '#core-tests/helpers/fig/patch'

import {
  exportFigFile,
  populateAllFigPages,
  populateFigPage
} from '@open-pencil/core/io/formats/fig'
import { parseFigBuffer } from '@open-pencil/fig'
import { EMPTY_EXPORT_RUNTIME } from '@open-pencil/fig/node-change'
import { SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import { computeImageHash } from '@open-pencil/scene-graph/images'
import { ownsSlotContent, slotPropertyId } from '@open-pencil/scene-graph/slots'
import { expectDefined } from '@open-pencil/test-support/assert'

import { archiveImagesNamedForFigma, writePatchedFigFile } from '#core/io/formats/fig/export/patch'
import { parseFigFileViaWorker } from '#core/io/formats/fig/read'
import {
  createFigPopulationWorker,
  releaseFigPopulationWorker,
  stopFigReaderWorker
} from '#core/kiwi/fig/population/client'
import { releaseFigArchive } from '#core/kiwi/fig/session/archive/access'
import { hasPendingReaderPages, isReaderPagePending } from '#core/kiwi/fig/session/document-state'

type Reader = 'local' | 'worker'

async function withReader(
  reader: Reader,
  bytes: Uint8Array,
  run: (graph: SceneGraph, populate: (id: string) => Promise<boolean | null>) => Promise<void>
): Promise<void> {
  const graph =
    reader === 'worker'
      ? await parseFigFileViaWorker(bytes.slice().buffer, { populate: 'first-page' })
      : await open(bytes)
  try {
    const worker = reader === 'worker' ? createFigPopulationWorker(graph) : null
    if (reader === 'worker' && !worker) throw new Error('Expected population worker')
    await run(graph, async (id) => (worker ? worker.populate(id) : populateFigPage(graph, id)))
  } finally {
    releaseFigPopulationWorker(graph)
  }
}

function addOwnedSlot(graph: SceneGraph, card: SceneNode, pageId: string): void {
  const propertyId = 'card:body'
  graph.updateNode(card.id, {
    componentPropertyDefinitions: [{ id: propertyId, name: 'Body', type: 'SLOT', defaultValue: '' }]
  })
  graph.createNode('FRAME', card.id, {
    name: 'Body',
    componentPropertyReferences: [{ propertyId, field: 'SLOT_CONTENT' }]
  })
  const instance = expectDefined(graph.createInstance(card.id, pageId, { name: 'Card cover' }))
  const slot = expectDefined(graph.getChildren(instance.id).find((node) => slotPropertyId(node)))
  graph.createNode('RECTANGLE', slot.id, { name: 'Owned content' })
  graph.updateNode(instance.id, { componentPropertyAssignments: { [propertyId]: '' } })
}

async function fixture({
  unrelated = false,
  legacyImage = false,
  unused = false,
  ownedSlot = false
} = {}) {
  const source = new SceneGraph()
  const [cover] = source.getPages()
  const library = source.addPage('Library')
  const uses = source.addPage('Uses')
  const other = source.addPage('Other uses')
  const card = source.createNode('COMPONENT', cover.id, { name: 'Card' })
  const obsolete = source.createNode('COMPONENT', library.id, { name: 'Obsolete' })
  source.createNode('RECTANGLE', obsolete.id, { name: 'Obsolete body' })
  source.createInstance(card.id, uses.id, { name: 'Card instance' })
  if (!unused)
    source.createInstance(obsolete.id, unrelated ? other.id : uses.id, {
      name: 'Obsolete instance'
    })
  if (ownedSlot) addOwnedSlot(source, card, cover.id)
  if (unused && legacyImage) {
    const internal = source.createNode('CANVAS', source.rootId, {
      name: 'Internal library',
      internalOnly: true
    })
    source.createNode('COMPONENT', internal.id, { name: 'Different internal component' })
  }
  if (!legacyImage) return exportFigFile(source)

  const photo = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7])
  const imageHash = computeImageHash(photo)
  source.images.set(imageHash, photo)
  source.createNode('RECTANGLE', cover.id, {
    name: 'Photo',
    fills: [
      {
        type: 'IMAGE',
        color: { r: 0, g: 0, b: 0, a: 1 },
        opacity: 1,
        visible: true,
        imageHash,
        imageScaleMode: 'FILL'
      }
    ]
  })
  const bytes = await exportFigFile(source)
  const parsed = parseFigBuffer(bytes.slice().buffer)
  const image = expectDefined(
    parsed.nodeChanges.find((record) => record.name === 'Photo')?.fillPaints?.[0]?.image
  )
  const legacyHash = '0123456789abcdef0123456789abcdef01234567'
  image.hash = Uint8Array.fromHex(legacyHash)
  return encodeArchive(parsed, [{ name: `images/${legacyHash}`, data: photo }])
}

function componentGuid(input: Uint8Array, name: string): string {
  return expectDefined([...recordsOf(input)].find(([, record]) => record.name === name))[0]
}

for (const reader of ['local', 'worker'] as const) {
  test.each(['legacy-image', 'missing-archive'] as const)(
    `refuses to rebuild a deleted component during full export: ${reader}, %s`,
    async (fallback) => {
      const input = await fixture({ legacyImage: fallback === 'legacy-image' })
      await withReader(reader, input, async (graph, populate) => {
        expect(await populate(pageNamed(graph, 'Library').id)).toBe(true)
        const uses = pageNamed(graph, 'Uses')
        expect(isReaderPagePending(graph, uses.id)).toBe(true)
        if (fallback === 'legacy-image') expect(await archiveImagesNamedForFigma(graph)).toBe(false)
        graph.updateNode(layerNamed(graph, 'Card').id, { name: 'Edited card' })
        const deletedId = layerNamed(graph, 'Obsolete').id
        graph.deleteNode(deletedId)
        if (fallback === 'missing-archive') releaseFigArchive(graph)
        const before = [...graph.nodes.keys()]

        await expect(exportFigFile(graph)).rejects.toThrow(/Missing resumed component/)

        expect([...graph.nodes.keys()]).toEqual(before)
        expect(graph.getNode(deletedId)).toBeUndefined()
        expect(isReaderPagePending(graph, uses.id)).toBe(true)
      })
    }
  )

  test.each(['legacy-image', 'slot-edit'] as const)(
    `saves an unused component's deletion with only the internal canvas pending: ${reader}, %s`,
    async (fallback) => {
      const slotEdit = fallback === 'slot-edit'
      const input = await fixture({ legacyImage: !slotEdit, unused: true, ownedSlot: slotEdit })
      await withReader(reader, input, async (graph, populate) => {
        for (const page of graph.getPages().slice(1)) expect(await populate(page.id)).toBe(true)
        const internal = expectDefined(graph.getPages(true).find((page) => page.internalOnly))
        expect(graph.getPages().every((page) => !isReaderPagePending(graph, page.id))).toBe(true)
        expect(isReaderPagePending(graph, internal.id)).toBe(true)
        expect(await archiveImagesNamedForFigma(graph)).toBe(slotEdit)
        graph.deleteNode(layerNamed(graph, 'Obsolete').id)
        if (slotEdit) {
          const content = layerNamed(graph, 'Owned content')
          const slot = expectDefined(graph.getNode(expectDefined(content.parentId)))
          expect(ownsSlotContent(graph, slot)).toBe(true)
          graph.updateNode(content.id, { name: 'Changed content' })
          expect(await writePatchedFigFile(graph, EMPTY_EXPORT_RUNTIME)).toBeNull()
        }
        const liveIds = [...graph.nodes.keys()]

        const records = recordsOf(await exportFigFile(graph))

        expect(records.has(componentGuid(input, 'Obsolete'))).toBe(false)
        expect(records.has(componentGuid(input, 'Obsolete body'))).toBe(false)
        const names = [...records.values()].map(({ name }) => name)
        expect(names).not.toContain('Obsolete')
        expect(names).toContain(slotEdit ? 'Changed content' : 'Different internal component')
        expect([...graph.nodes.keys()]).toEqual(liveIds)
        expect(isReaderPagePending(graph, internal.id)).toBe(true)
      })
    }
  )

  test(`rewrites legacy images and pending component uses during full export: ${reader}`, async () => {
    const input = await fixture({ legacyImage: true })
    await withReader(reader, input, async (graph, populate) => {
      expect(await populate(pageNamed(graph, 'Library').id)).toBe(true)
      const uses = pageNamed(graph, 'Uses')
      expect(isReaderPagePending(graph, uses.id)).toBe(true)
      expect(await archiveImagesNamedForFigma(graph)).toBe(false)
      graph.updateNode(layerNamed(graph, 'Card').id, { name: 'Edited card' })
      const before = [...graph.nodes.keys()]

      const output = await exportFigFile(graph)
      const records = recordsOf(output)
      expect(records.get(componentGuid(input, 'Card'))?.name).toBe('Edited card')
      expect(records.get(componentGuid(input, 'Obsolete'))?.type).toBe('SYMBOL')
      const reopened = await open(output)
      expect(await archiveImagesNamedForFigma(reopened)).toBe(true)
      expect(populateFigPage(reopened, pageNamed(reopened, 'Uses').id)).toBe(true)
      expect(layerNamed(reopened, 'Obsolete instance').componentId).toBe(
        layerNamed(reopened, 'Obsolete').id
      )
      expect([...graph.nodes.keys()]).toEqual(before)
      expect(isReaderPagePending(graph, uses.id)).toBe(true)
    })
  })

  test.each(['pending-use', 'loaded-use', 'unrelated-use'] as const)(
    `refuses an occupied GUID of a deleted component: ${reader}, %s`,
    async (location) => {
      const input = await fixture({ unrelated: location === 'unrelated-use' })
      const guid = componentGuid(input, 'Obsolete')
      await withReader(reader, input, async (graph, populate) => {
        graph.applyImportedStateDuring(() =>
          graph.createNodeWithId(guid, 'RECTANGLE', graph.getPages()[0].id, {
            name: 'Unrelated imported layer'
          })
        )
        expect(await populate(pageNamed(graph, 'Library').id)).toBe(true)
        const uses = pageNamed(graph, 'Uses')
        if (location === 'loaded-use') expect(await populate(uses.id)).toBe(true)
        const usedPage = location === 'unrelated-use' ? pageNamed(graph, 'Other uses') : uses
        expect(isReaderPagePending(graph, usedPage.id)).toBe(location !== 'loaded-use')
        graph.updateNode(layerNamed(graph, 'Card').id, { name: 'Edited card' })
        const deletedId = layerNamed(graph, 'Obsolete').id
        expect(deletedId).not.toBe(guid)
        graph.deleteNode(deletedId)
        // The synthetic collision was injected on the main thread. Keep the worker's page
        // checkpoint and serve the original archive locally from here.
        if (reader === 'worker') stopFigReaderWorker(graph)
        const before = [...graph.nodes.keys()]

        await expect(exportFigFile(graph)).rejects.toThrow(
          /Missing (?:resumed|materialized) component/
        )

        expect([...graph.nodes.keys()]).toEqual(before)
        expect(graph.getNode(deletedId)).toBeUndefined()
        expect(graph.getNode(guid)?.type).toBe('RECTANGLE')
        expect(isReaderPagePending(graph, usedPage.id)).toBe(location !== 'loaded-use')
      })
    }
  )
}

test('a full export keeps a deleted component GUID out of new variable records', async () => {
  const source = new SceneGraph()
  const library = source.addPage('Library')
  source.createNode('COMPONENT', library.id, { name: 'Unused component' })
  const input = await exportFigFile(source)
  const deletedGuid = componentGuid(input, 'Unused component')
  const graph = await open(input)
  expect(populateAllFigPages(graph)).toBe(true)
  expect(hasPendingReaderPages(graph)).toBe(false)
  graph.deleteNode(layerNamed(graph, 'Unused component').id)
  const collection = new SceneGraph().createCollection('New palette')
  graph.addCollection({ ...collection, id: deletedGuid })
  releaseFigArchive(graph)

  const output = await exportFigFile(graph)

  expect(recordsOf(output).has(deletedGuid)).toBe(false)
  const reopened = await open(output)
  expect([...reopened.variableCollections.values()].map(({ name }) => name)).toEqual([
    'New palette'
  ])
})
