import { describe, expect, setDefaultTimeout, test } from 'bun:test'

import { open } from '#core-tests/helpers/fig/archive'
import {
  exportBothWays,
  fixtureBytes,
  guidKey,
  layerNamed,
  pageNamed,
  recordsOf,
  shapeOf
} from '#core-tests/helpers/fig/patch'
import { isEqual } from 'es-toolkit/predicate'

import {
  exportFigFile,
  populateAllFigPages,
  populateFigPage
} from '@open-pencil/core/io/formats/fig'
import { patchFigArchive, readStreamBytes } from '@open-pencil/fig'
import { initCodec, type NodeChange } from '@open-pencil/kiwi/fig/codec'
import { SceneGraph } from '@open-pencil/scene-graph'
import { cloneNodeProps } from '@open-pencil/scene-graph/copy'
import { expectDefined } from '@open-pencil/test-support/assert'

import { parseFigFileViaWorker } from '#core/io/formats/fig/read'
import {
  createFigPopulationWorker,
  releaseFigPopulationWorker
} from '#core/kiwi/fig/population/client'
import { archiveBaseline } from '#core/kiwi/fig/session/archive/changes'
import {
  hasPendingReaderPages,
  isReaderPagePending,
  populateFigInternalPages,
  readerCheckpoint
} from '#core/kiwi/fig/session/document-state'

setDefaultTimeout(60_000)

describe('writing an edited document into its archive', () => {
  test('rewrites only the record an edit changed', async () => {
    const { bytes, patched } = await exportBothWays((graph) =>
      graph.updateNode(layerNamed(graph, 'B').id, { name: 'B renamed' })
    )
    const before = recordsOf(bytes)
    const after = recordsOf(patched)
    expect([...after.keys()].toSorted()).toEqual([...before.keys()].toSorted())
    const changed = [...after].filter(([guid, record]) => !isEqual(before.get(guid), record))
    expect(changed.map(([, record]) => record.name)).toEqual(['B renamed'])
  })

  test('writes a dash an edit sets on a stroke, as the stroke panel does', async () => {
    const { patched } = await exportBothWays((graph) => {
      const layer = layerNamed(graph, 'A')
      graph.updateNode(layer.id, {
        strokes: [
          {
            type: 'SOLID',
            color: { r: 0, g: 0, b: 1, a: 1 },
            opacity: 1,
            visible: true,
            weight: 2,
            align: 'INSIDE',
            dashPattern: [6, 4]
          }
        ]
      })
    })
    const reopened = layerNamed(await open(patched), 'A')
    expect(reopened.dashPattern).toEqual([6, 4])
    expect(reopened.strokes[0]?.dashPattern).toEqual([6, 4])
  })

  test('still rewrites only the edited record once every page is loaded', async () => {
    const bytes = await fixtureBytes()
    const graph = await open(bytes)
    // Loading the last page releases the decoded reader; the archive keeps serving saves.
    populateAllFigPages(graph)
    populateFigInternalPages(graph)
    expect(hasPendingReaderPages(graph)).toBe(false)
    graph.updateNode(layerNamed(graph, 'B').id, { name: 'B renamed' })
    const before = recordsOf(bytes)
    const after = recordsOf(await exportFigFile(graph))
    const changed = [...after].filter(([guid, record]) => !isEqual(before.get(guid), record))
    expect(changed.map(([, record]) => record.name)).toEqual(['B renamed'])
  })

  test('preserves unrelated archive fields while component use pages stay pending', async () => {
    const bytes = await fixtureBytes()
    const variable = [...recordsOf(bytes).values()].find((record) => record.name === 'brand')
    if (!variable) throw new Error('Expected brand variable')
    const annotated = await readStreamBytes(
      patchFigArchive(
        bytes.slice().buffer,
        {
          records: [{ ...variable, sortPosition: 'preserved-order', isSoftDeleted: false }],
          blobs: [],
          removed: [],
          replaceVariables: false
        },
        { thumbnailPNG: new Uint8Array(), metaJSON: '{}', images: [] }
      )
    )
    const before = [...recordsOf(annotated).values()].find((record) => record.name === 'brand')
    expect(before?.sortPosition).toBe('preserved-order')

    const results: Array<{
      scenario: string
      sortPosition: unknown
      pending: boolean
      pendingAfter: boolean
      usedPending: boolean
      usedPendingAfter: boolean
      nodeCount: number
      nodeCountAfter: number
      renamed: boolean
    }> = []
    for (const scenario of [
      'pending-use-page',
      'pending-unrelated-page',
      'no-pending-pages',
      'non-component-edit'
    ] as const) {
      const graph = await open(annotated)
      const library = pageNamed(graph, 'Library')
      const used = pageNamed(graph, 'Used')
      if (scenario !== 'non-component-edit') populateFigPage(graph, library.id)
      if (scenario === 'pending-unrelated-page') populateFigPage(graph, used.id)
      if (scenario === 'no-pending-pages') {
        populateAllFigPages(graph)
        populateFigInternalPages(graph)
      }
      const pending = hasPendingReaderPages(graph)
      const usedPending = isReaderPagePending(graph, used.id)
      const nodeCount = graph.nodes.size
      const layer = layerNamed(graph, scenario === 'non-component-edit' ? 'B' : 'Card')
      graph.updateNode(layer.id, { name: 'Renamed' })

      const records = [...recordsOf(await exportFigFile(graph)).values()]
      results.push({
        scenario,
        sortPosition: records.find((record) => record.name === 'brand')?.sortPosition,
        pending,
        pendingAfter: hasPendingReaderPages(graph),
        usedPending,
        usedPendingAfter: isReaderPagePending(graph, used.id),
        nodeCount,
        nodeCountAfter: graph.nodes.size,
        renamed: records.some((record) => record.name === 'Renamed')
      })
    }
    for (const result of results) {
      expect(result.renamed, result.scenario).toBe(true)
      expect(result.sortPosition, result.scenario).toBe('preserved-order')
      expect(result.pendingAfter, result.scenario).toBe(result.pending)
      expect(result.usedPendingAfter, result.scenario).toBe(result.usedPending)
      expect(result.nodeCountAfter, result.scenario).toBe(result.nodeCount)
    }
  })

  test.each([
    'loaded-first-page',
    'pending-use-page',
    'pending-unrelated-page',
    'acyclic-control',
    'page-loading-in-worker'
  ] as const)('saves a repaired component loop on the %s', async (location) => {
    await initCodec()
    const source = new SceneGraph()
    const [cover] = source.getPages()
    const card = source.createNode('COMPONENT', cover.id, { name: 'Card', width: 20, height: 20 })
    const leaf = source.createNode('COMPONENT', cover.id, { name: 'Leaf', width: 20, height: 20 })
    const used = source.addPage('Used')
    source.createInstance(card.id, used.id, { name: 'Card use' })
    const elsewhere = source.addPage('Elsewhere')
    let page = used
    if (location === 'loaded-first-page') page = cover
    if (location === 'pending-unrelated-page') page = elsewhere
    const loop = source.createNode('COMPONENT', page.id, { name: 'Loop', width: 20, height: 20 })
    source.createInstance(leaf.id, loop.id, { name: 'Nested loop slot' })
    const pristine = await exportFigFile(source)
    const original = recordsOf(pristine)
    const container = [...original.values()].find((record) => record.name === 'Loop')
    const nested = [...original.values()].find((record) => record.name === 'Nested loop slot')
    if (!container?.guid || !nested?.guid || !nested.symbolData)
      throw new Error('Missing loop records')
    const nestedId = guidKey(nested)
    const hasCycle = location !== 'acyclic-control'
    const bytes = hasCycle
      ? await readStreamBytes(
          patchFigArchive(
            pristine.slice().buffer,
            {
              records: [
                { ...nested, symbolData: { ...nested.symbolData, symbolID: container.guid } }
              ],
              blobs: [],
              removed: [],
              replaceVariables: false
            },
            { thumbnailPNG: new Uint8Array(), metaJSON: '{}', images: [] }
          )
        )
      : pristine
    if (location === 'page-loading-in-worker') {
      const graph = await parseFigFileViaWorker(bytes.slice().buffer, { populate: 'first-page' })
      try {
        const worker = expectDefined(createFigPopulationWorker(graph))
        const usePage = pageNamed(graph, 'Used')
        expect(isReaderPagePending(graph, usePage.id)).toBe(true)
        const loading = worker.populate(usePage.id)
        expect(readerCheckpoint(graph)?.droppedRecordIds).not.toContain(nestedId)

        const saved = recordsOf(await exportFigFile(graph))

        expect(await loading).toBe(true)
        expect(readerCheckpoint(graph)?.droppedRecordIds).toContain(nestedId)
        expect(saved.has(nestedId)).toBe(false)
      } finally {
        releaseFigPopulationWorker(graph)
      }
      return
    }
    const graph = await open(bytes)
    const usePage = pageNamed(graph, 'Used')
    expect(isReaderPagePending(graph, usePage.id)).toBe(true)
    graph.updateNode(layerNamed(graph, 'Card').id, { name: 'Renamed card' })
    const saved = recordsOf(await exportFigFile(graph))
    expect([...saved.values()].some((record) => record.name === 'Renamed card')).toBe(true)
    expect(saved.has(nestedId)).toBe(!hasCycle || location === 'pending-unrelated-page')
    expect(isReaderPagePending(graph, usePage.id)).toBe(true)
  })

  for (const reader of ['local', 'worker'] as const) {
    for (const scenario of [
      'same-pending-page',
      'unrelated-pending-page',
      'same-loaded-page',
      'same-internal-page'
    ] as const) {
      test(`does not resurrect a deleted component: ${reader}, ${scenario}`, async () => {
        await initCodec()
        const source = new SceneGraph()
        const [cover] = source.getPages()
        const library =
          scenario === 'same-internal-page'
            ? source.createNode('CANVAS', source.rootId, {
                name: 'Internal library',
                internalOnly: true
              })
            : source.addPage('Library')
        const uses = source.addPage('Uses')
        const others = source.addPage('Other uses')
        const card = source.createNode(
          'COMPONENT',
          scenario === 'same-internal-page' ? library.id : cover.id,
          { name: 'Card' }
        )
        const obsolete = source.createNode('COMPONENT', library.id, { name: 'Obsolete' })
        source.createNode('RECTANGLE', obsolete.id, { name: 'Obsolete body' })
        source.createInstance(card.id, uses.id, { name: 'Card instance' })
        source.createInstance(
          obsolete.id,
          scenario === 'unrelated-pending-page' ? others.id : uses.id,
          { name: 'Obsolete instance' }
        )
        const input = await exportFigFile(source)
        const original = recordsOf(input)
        const obsoleteGuid = [...original].find(([, record]) => record.name === 'Obsolete')?.[0]
        const bodyGuid = [...original].find(([, record]) => record.name === 'Obsolete body')?.[0]
        const cardGuid = [...original].find(([, record]) => record.name === 'Card')?.[0]
        if (!obsoleteGuid || !bodyGuid || !cardGuid) throw new Error('Missing component records')
        const graph =
          reader === 'worker'
            ? await parseFigFileViaWorker(input.slice().buffer, { populate: 'first-page' })
            : await open(input)
        try {
          const worker = reader === 'worker' ? createFigPopulationWorker(graph) : null
          if (reader === 'worker' && !worker) throw new Error('Expected population worker')
          const populate = async (id: string) =>
            worker ? await worker.populate(id) : populateFigPage(graph, id)
          const libraryPage = graph
            .getPages(true)
            .find(
              (page) =>
                page.name === (scenario === 'same-internal-page' ? 'Internal library' : 'Library')
            )
          if (!libraryPage) throw new Error('Missing library page')
          expect(await populate(libraryPage.id)).toBe(true)
          const usePage = pageNamed(graph, 'Uses')
          if (scenario === 'same-loaded-page') expect(await populate(usePage.id)).toBe(true)
          expect(isReaderPagePending(graph, usePage.id)).toBe(scenario !== 'same-loaded-page')
          graph.updateNode(layerNamed(graph, 'Card').id, { name: 'Edited card' })
          graph.deleteNode(layerNamed(graph, 'Obsolete').id)
          const before = [...graph.nodes.keys()]
          const records = recordsOf(await exportFigFile(graph))
          expect(records.get(cardGuid)?.name).toBe('Edited card')
          expect([...graph.nodes.keys()]).toEqual(before)
          expect(isReaderPagePending(graph, usePage.id)).toBe(scenario !== 'same-loaded-page')
          expect(records.has(obsoleteGuid)).toBe(false)
          expect(records.has(bodyGuid)).toBe(false)
          expect([...records.values()].some((record) => record.name === 'Obsolete body')).toBe(
            false
          )
        } finally {
          releaseFigPopulationWorker(graph)
        }
      })
    }
  }

  test.each([true, false])(
    'saves an edited component after another loaded component was deleted (internal page: %s)',
    async (withInternalPage) => {
      await initCodec()
      const source = new SceneGraph()
      const [cover] = source.getPages()
      const library = source.addPage('Library')
      const card = source.createNode('COMPONENT', cover.id, { name: 'Public card' })
      const obsolete = source.createNode('COMPONENT', library.id, { name: 'Obsolete asset' })
      source.createNode('RECTANGLE', obsolete.id, { name: 'Obsolete child' })
      const used = source.addPage('Used')
      source.createInstance(card.id, used.id, { name: 'First use' })
      const usedAgain = source.addPage('Used again')
      source.createInstance(card.id, usedAgain.id, { name: 'Second use' })
      if (withInternalPage) {
        const internal = source.createNode('CANVAS', source.rootId, {
          name: 'Internal dependencies',
          internalOnly: true
        })
        source.createInstance(obsolete.id, internal.id, { name: 'Archived internal use' })
      }
      const bytes = await exportFigFile(source)
      const graph = await open(bytes)
      populateFigPage(graph, pageNamed(graph, 'Library').id)
      const usePage = pageNamed(graph, 'Used')
      const secondUsePage = pageNamed(graph, 'Used again')
      const internalPage = graph.getPages(true).find((page) => page.internalOnly)
      if (withInternalPage && !internalPage) throw new Error('Missing internal page')
      expect(isReaderPagePending(graph, usePage.id)).toBe(true)
      expect(isReaderPagePending(graph, secondUsePage.id)).toBe(true)
      if (internalPage) expect(isReaderPagePending(graph, internalPage.id)).toBe(true)
      const edited = layerNamed(graph, 'Public card')
      const deleted = layerNamed(graph, 'Obsolete asset')
      const deletedSourceId = expectDefined(
        [...recordsOf(bytes)].find(([, record]) => record.name === 'Obsolete asset')
      )[0]
      graph.updateNode(edited.id, { name: 'Renamed public card' })
      graph.deleteNode(deleted.id)
      const nodesBefore = [...graph.nodes.keys()]
      const records = recordsOf(await exportFigFile(graph))
      expect([...records.values()].some((record) => record.name === 'Renamed public card')).toBe(
        true
      )
      expect([...records.values()].some((record) => record.name === 'Obsolete asset')).toBe(false)
      expect(records.has(deletedSourceId)).toBe(false)
      for (const name of [
        'First use',
        'Second use',
        ...(withInternalPage ? ['Archived internal use'] : [])
      ]) {
        const original = [...recordsOf(bytes)].find(([, record]) => record.name === name)
        if (!original) throw new Error(`Missing original record ${name}`)
        expect(records.has(original[0])).toBe(true)
      }
      expect([...graph.nodes.keys()]).toEqual(nodesBefore)
      expect(isReaderPagePending(graph, usePage.id)).toBe(true)
      expect(isReaderPagePending(graph, secondUsePage.id)).toBe(true)
      if (internalPage) expect(isReaderPagePending(graph, internalPage.id)).toBe(true)
    }
  )

  test('exporting pending component uses does not change the live archive edit accounting', async () => {
    const graph = await open(await fixtureBytes())
    const used = pageNamed(graph, 'Used')
    populateFigPage(graph, pageNamed(graph, 'Library').id)
    graph.updateNode(layerNamed(graph, 'Card').id, { name: 'Renamed card' })
    populateFigPage(graph, pageNamed(graph, 'Bound').id)
    const before = structuredClone(expectDefined(archiveBaseline(graph)))
    expect(before.loadedAfterEdits.size).toBeGreaterThan(0)
    expect(isReaderPagePending(graph, used.id)).toBe(true)
    const output = await exportFigFile(graph)
    expect([...recordsOf(output).values()].some((record) => record.name === 'Renamed card')).toBe(
      true
    )
    expect(archiveBaseline(graph)).toEqual(before)
    expect(isReaderPagePending(graph, used.id)).toBe(true)
  })

  const edits: Array<[string, (graph: SceneGraph) => void]> = [
    ['moving a layer', (graph) => graph.updateNode(layerNamed(graph, 'A').id, { x: 120, y: 90 })],
    [
      'adding a layer between siblings',
      (graph) => {
        const frame = layerNamed(graph, 'Frame')
        const added = graph.createNode('RECTANGLE', frame.id, { name: 'New', width: 5, height: 5 })
        graph.insertChildAt(added.id, frame.id, 1)
      }
    ],
    ['deleting a frame and its layers', (graph) => graph.deleteNode(layerNamed(graph, 'Frame').id)],
    [
      'moving a layer out of a frame it then deletes',
      (graph) => {
        const page = pageNamed(graph, graph.getPages()[0].name)
        graph.reparentNode(layerNamed(graph, 'C').id, page.id)
        graph.deleteNode(layerNamed(graph, 'Frame').id)
      }
    ],
    [
      'reordering siblings',
      (graph) => graph.insertChildAt(layerNamed(graph, 'C').id, layerNamed(graph, 'Frame').id, 0)
    ],
    [
      'copying a layer with its source GUID, as a paste does',
      (graph) => {
        const dot = layerNamed(graph, 'Dot')
        graph.createNode(dot.type, graph.getPages()[0].id, {
          ...cloneNodeProps(dot, null),
          name: 'Dot copy',
          x: 400
        })
      }
    ],
    [
      'editing a component whose instances are on a page not loaded yet',
      (graph) => {
        populateFigPage(graph, pageNamed(graph, 'Library').id)
        graph.updateNode(layerNamed(graph, 'Body').id, { height: 60 })
        graph.updateNode(layerNamed(graph, 'Card').id, { height: 60 })
      }
    ],
    [
      'overriding a layer inside an instance',
      (graph) => {
        const used = pageNamed(graph, 'Used')
        populateFigPage(graph, used.id)
        const [instance] = graph.getChildren(used.id)
        const [body] = graph.getChildren(instance.id)
        graph.updateNode(body.id, { opacity: 0.5, name: 'Body override' })
      }
    ],
    [
      'deleting a layer of a component whose instances are on a page not loaded yet',
      (graph) => {
        const library = pageNamed(graph, 'Library')
        populateFigPage(graph, library.id)
        const [body] = graph.getChildren(layerNamed(graph, 'Card').id)
        graph.deleteNode(body.id)
      }
    ],
    ['adding a page', (graph) => graph.addPage('Added')]
  ]
  for (const [name, edit] of edits) {
    test(`reopens as the full export does after ${name}`, async () => {
      const { patched, full } = await exportBothWays(edit)
      expect(await shapeOf(patched)).toEqual(await shapeOf(full))
    })
  }

  test("keeps the document's plugin data an edit sets on it", async () => {
    const { patched } = await exportBothWays((graph) => {
      const root = expectDefined(graph.getNode(graph.rootId))
      graph.updateNode(root.id, {
        pluginData: [...root.pluginData, { pluginId: 'probe', key: 'note', value: 'kept' }]
      })
    })
    const reopened = await open(patched)
    expect(reopened.getNode(reopened.rootId)?.pluginData).toContainEqual({
      pluginId: 'probe',
      key: 'note',
      value: 'kept'
    })
  })

  test('keeps a change to the libraries the document enables', async () => {
    const binding = { libraryId: 'ds', revisionId: 'two', enabled: true }
    const { patched } = await exportBothWays((graph) => {
      graph.enabledLibraries.set('ds', binding)
    })
    const reopened = await open(patched)
    expect(reopened.enabledLibraries.get('ds')).toEqual(binding)
  })

  test('keeps every archive record its own when a new variable takes an ID it uses', async () => {
    const bytes = await fixtureBytes()
    const graph = await open(bytes)
    // A new ID that happens to equal a layer's record on a page not loaded yet: the record must
    // stay the layer's.
    const variableGuid = [...recordsOf(bytes)].find(([, record]) => record.name === 'Branded')?.[0]
    if (!variableGuid) throw new Error('Expected the Branded layer record')
    const [collection] = graph.variableCollections.values()
    const [existing] = graph.variables.values()
    graph.addVariable({ ...structuredClone(existing), id: variableGuid, name: 'added' })
    collection.variableIds.push(variableGuid)
    const patched = await exportFigFile(graph)
    const before = recordsOf(bytes)
    const after = recordsOf(patched)
    for (const [guid, record] of before) {
      expect(after.get(guid)?.type).toBe(record.type)
      expect(after.get(guid)?.name).toBe(record.name)
    }
    const added = [...after.values()].filter((record) => !before.has(guidKey(record)))
    expect(added.map((record) => record.name)).toEqual(['added'])
  })

  test('writes a layer into its own record when something cleared its source id', async () => {
    const bytes = await fixtureBytes()
    const graph = await open(bytes)
    // A room's copy of a layer carries no source metadata; the layer's ID still names its record.
    const page = graph.getPages()[0]
    for (const node of [page, ...graph.getChildren(page.id)])
      graph.updateNode(node.id, { source: { ...structuredClone(node.source), id: '' } })
    const patched = await exportFigFile(graph)
    const before = recordsOf(bytes)
    const after = recordsOf(patched)
    expect([...after.keys()].toSorted()).toEqual([...before.keys()].toSorted())
    for (const [guid, record] of before)
      expect(after.get(guid)?.parentIndex).toEqual(record.parentIndex)
  })

  test('rewrites instances on unopened pages when their component loses a layer', async () => {
    const bytes = await fixtureBytes()
    const graph = await open(bytes)
    populateFigPage(graph, pageNamed(graph, 'Library').id)
    const [body] = graph.getChildren(layerNamed(graph, 'Card').id)
    graph.deleteNode(body.id)
    const before = recordsOf(bytes)
    const after = recordsOf(await exportFigFile(graph))
    const [bodyGuid, bodyRecord] = expectDefined(
      [...before].find(([, record]) => record.name === 'Body')
    )
    const instances = (records: Map<string, NodeChange>) =>
      [...records.values()].filter((record) => record.type === 'INSTANCE')
    // Instances address the component's layer by its GUID in their derived geometry.
    const addressesBody = (record: NodeChange) =>
      JSON.stringify(record).includes(JSON.stringify(bodyRecord.guid))
    expect(instances(before).every(addressesBody)).toBe(true)
    expect(after.has(bodyGuid)).toBe(false)
    expect(instances(after)).toHaveLength(2)
    expect(instances(after).some(addressesBody)).toBe(false)
  })
})
