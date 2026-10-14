/**
 * Behavioral checks for the built Host half.
 *
 * These run the real `lib/host/index.js` against a temporary DSH_HOME and a
 * minimal fake ctx, so store semantics, the injection section, the RPC route
 * and the switch command are all exercised rather than assumed.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  COMMAND_NAME,
  PromptStore,
  RPC_PATH,
  SECTION_NAME,
  SECTION_ORDER,
  apply,
  defaultStore,
  nextPromptId,
  nextPromptName,
  normalizeStore,
  resolveStorePath,
  uniqueName,
} from '../lib/host/index.js'

/** Cordis runs an effect callback immediately and keeps its disposer. */
function fakeEffect(callback) {
  const disposer = callback()
  return () => {
    if (typeof disposer === 'function') disposer()
  }
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-spe-'))
}

test('default store is 提示词1 and active', () => {
  const store = new PromptStore(tempHome())
  const view = store.view()
  assert.equal(view.prompts.length, 1)
  assert.equal(view.prompts[0].name, '提示词1')
  assert.equal(view.prompts[0].content, '')
  assert.equal(view.activeId, view.prompts[0].id)
  assert.equal(view.persistence.mode, 'disk')
})

test('create/rename/update/duplicate/delete/activate round-trip and persist', () => {
  const home = tempHome()
  const store = new PromptStore(home)

  // create -> 提示词2, and the new id is returned for selection
  const created = store.create()
  assert.equal(created.prompts.length, 2)
  assert.equal(created.createdId, 'prompt-2')
  assert.equal(created.prompts[1].name, '提示词2')

  // rename
  store.rename('prompt-2', '客服助手')
  assert.equal(store.view().prompts[1].name, '客服助手')

  // update content; the active prompt is still 提示词1 and stays empty
  store.update('prompt-2', '你是一名客服。')
  assert.equal(store.getActive().content, '')

  // duplicate -> 「客服助手 副本」, content copied
  const dup = store.duplicate('prompt-2')
  assert.equal(dup.createdId, 'prompt-3')
  assert.equal(dup.prompts[2].name, '客服助手 副本')
  assert.equal(dup.prompts[2].content, '你是一名客服。')

  // activate
  const activated = store.activate('prompt-2')
  assert.equal(activated.activeId, 'prompt-2')
  assert.equal(store.getActive().content, '你是一名客服。')

  // delete the active one -> falls back to the first remaining prompt
  const afterDelete = store.remove('prompt-2')
  assert.equal(afterDelete.prompts.length, 2)
  assert.equal(afterDelete.activeId, 'prompt-1')
  assert.equal(store.activeContent, '')

  // disk holds exactly the reported data
  const onDisk = JSON.parse(readFileSync(resolveStorePath(home), 'utf8'))
  assert.deepEqual(onDisk, { activeId: afterDelete.activeId, prompts: afterDelete.prompts })

  // a fresh store in the same home sees the persisted state
  const reopened = new PromptStore(home)
  assert.deepEqual(reopened.view().prompts, afterDelete.prompts)
  assert.equal(reopened.view().activeId, afterDelete.activeId)
  rmSync(home, { recursive: true, force: true })
})

test('the last prompt cannot be deleted', () => {
  const store = new PromptStore(tempHome())
  assert.throws(() => store.remove('prompt-1'), /最后一个提示词不能删除/)
  assert.equal(store.view().prompts.length, 1)
})

test('empty content is not injected; agent-less context is not injected', () => {
  /** Activate one plugin instance against `home` and capture its section. */
  function sectionFor(home) {
    process.env.DSH_HOME = home
    let section = null
    apply({
      effect: fakeEffect,
      systemPrompt: { section: (definition) => { section = definition; return () => {} } },
      inject: () => {},
    })
    return section
  }

  // Default state: the only prompt is empty, so nothing is injected.
  const emptyHome = tempHome()
  const emptySection = sectionFor(emptyHome)
  assert.equal(emptySection.name, SECTION_NAME)
  assert.equal(emptySection.order, SECTION_ORDER)
  assert.equal(emptySection.interpolate, false)
  assert.equal(emptySection.text({ agent: {} }), '', 'an empty prompt must not be injected')
  assert.equal(emptySection.text({}), '', 'a context without an agent must not be injected')

  // A prompt that was persisted with content is injected, and only for an agent.
  const filledHome = tempHome()
  writeFileSync(resolveStorePath(filledHome), JSON.stringify({
    activeId: 'prompt-1',
    prompts: [{ id: 'prompt-1', name: '提示词1', content: '只说中文。', createdAt: 1, updatedAt: 1 }],
  }), 'utf8')
  const filledSection = sectionFor(filledHome)
  assert.equal(filledSection.text({ agent: {} }), '只说中文。')
  assert.equal(filledSection.text({}), '')
  assert.equal(filledSection.text(undefined), '')

  // Whitespace-only content is treated as empty.
  const blankHome = tempHome()
  writeFileSync(resolveStorePath(blankHome), JSON.stringify({
    activeId: 'prompt-1',
    prompts: [{ id: 'prompt-1', name: '提示词1', content: '   \n  ', createdAt: 1, updatedAt: 1 }],
  }), 'utf8')
  assert.equal(sectionFor(blankHome).text({ agent: {} }), '')

  delete process.env.DSH_HOME
  for (const home of [emptyHome, filledHome, blankHome]) rmSync(home, { recursive: true, force: true })
})

test('unreadable store degrades instead of throwing', () => {
  const home = tempHome()
  writeFileSync(resolveStorePath(home), '{ not json', 'utf8')
  const store = new PromptStore(home)
  assert.equal(store.view().prompts.length, 1)
  assert.equal(store.view().persistence.mode, 'disk')
  assert.match(store.view().persistence.error, /解析失败/)
  // The unreadable original is preserved, not destroyed: the store moves it
  // aside under a `.corrupt-<ts>` name instead of overwriting it.
  assert.equal(existsSync(resolveStorePath(home)), false, 'the corrupt store is moved out of the way')
  const preserved = readdirSync(home).filter((name) => name.includes('.corrupt-'))
  assert.equal(preserved.length, 1, 'the corrupt store is preserved under a backup name')
  assert.equal(readFileSync(join(home, preserved[0]), 'utf8'), '{ not json')
  rmSync(home, { recursive: true, force: true })
})

test('failed disk write degrades to memory-only and reports it', () => {
  // A file where a directory is required makes every write fail.
  const home = tempHome()
  const blocked = join(home, 'blocked')
  writeFileSync(blocked, 'this is a file, not a directory', 'utf8')
  const store = new PromptStore(blocked)
  const view = store.create()
  assert.equal(view.persistence.mode, 'memory')
  assert.notEqual(view.persistence.error, '')
  assert.equal(view.prompts.length, 2, 'in-memory state still updates')
  assert.equal(store.activeContent, '', 'injection still reads the cache')
  store.update('prompt-2', '内存模式内容')
  store.activate('prompt-2')
  assert.equal(store.activeContent, '内存模式内容')
  rmSync(home, { recursive: true, force: true })
})

test('RPC route serves the documented methods over HTTP semantics', async () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  let route = null
  const ctx = {
    effect: fakeEffect,
    systemPrompt: { section: () => () => {} },
    inject: (names, callback) => {
      if (names.includes('webServer')) {
        callback({ effect: fakeEffect, webServer: { register: (registered) => { route = registered; return () => {} } } })
      }
      if (names.includes('commands')) {
        callback({ effect: fakeEffect, commands: { register: () => () => {} } })
      }
    },
  }
  apply(ctx)
  assert.equal(route.path, RPC_PATH)
  assert.equal(route.kind, 'exact')

  /** Invoke the route with one JSON body and collect the response. */
  async function rpc(method, params, headers = {}) {
    let status = 0
    let body = ''
    const request = {
      method: 'POST',
      headers: { host: '127.0.0.1:19387', ...headers },
      on(event, listener) {
        if (event === 'data') listener(Buffer.from(JSON.stringify({ method, params })))
        if (event === 'end') listener()
      },
      destroy() {},
    }
    const response = {
      writeHead(nextStatus) { status = nextStatus },
      end(chunk) { body = chunk ?? '' },
    }
    await route.handler(request, response)
    return { status, body: JSON.parse(body) }
  }

  const list = await rpc('system-prompt/list')
  assert.equal(list.status, 200)
  assert.equal(list.body.ok, true)
  assert.equal(list.body.value.prompts[0].name, '提示词1')

  const created = await rpc('system-prompt/create')
  assert.equal(created.body.value.createdId, 'prompt-2')

  const renamed = await rpc('system-prompt/rename', { id: 'prompt-2', name: '写作助手' })
  assert.equal(renamed.body.value.prompts[1].name, '写作助手')

  const updated = await rpc('system-prompt/update', { id: 'prompt-2', content: '你是写作助手。' })
  assert.equal(updated.body.value.prompts[1].content, '你是写作助手。')

  const switched = await rpc('system-prompt/activate', { id: 'prompt-2' })
  assert.equal(switched.body.value.activeId, 'prompt-2')

  const active = await rpc('system-prompt/get-active')
  assert.equal(active.body.value.content, '你是写作助手。')

  const duplicated = await rpc('system-prompt/duplicate', { id: 'prompt-2' })
  assert.equal(duplicated.body.value.prompts[2].name, '写作助手 副本')

  const deleted = await rpc('system-prompt/delete', { id: 'prompt-2' })
  assert.equal(deleted.body.value.activeId, 'prompt-1')

  // Typed failures stay typed.
  const missing = await rpc('system-prompt/rename', { id: 'nope', name: 'x' })
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.error.code, 'not-found')

  const unknown = await rpc('system-prompt/does-not-exist')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'method-not-found')

  const emptyName = await rpc('system-prompt/rename', { id: 'prompt-1', name: '   ' })
  assert.equal(emptyName.body.error.code, 'invalid-argument')

  // Cross-origin is refused.
  const blocked = await rpc('system-prompt/list', undefined, { 'sec-fetch-site': 'cross-site' })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.error.code, 'cross-origin')

  // Deleting the last remaining prompt is refused. The duplicate created above
  // still exists, so it has to go first for only one prompt to be left.
  const duplicateId = duplicated.body.value.prompts[2].id
  const removedDuplicate = await rpc('system-prompt/delete', { id: duplicateId })
  assert.equal(removedDuplicate.body.value.prompts.length, 1)
  const lastDelete = await rpc('system-prompt/delete', { id: 'prompt-1' })
  assert.equal(lastDelete.body.ok, false)
  assert.equal(lastDelete.body.error.code, 'last-prompt')

  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

test('switch command accepts a name or an id and rejects the rest', () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  let definition = null
  const ctx = {
    effect: fakeEffect,
    systemPrompt: { section: () => () => {} },
    inject: (names, callback) => {
      if (names.includes('commands')) {
        callback({ effect: fakeEffect, commands: { register: (registered) => { definition = registered; return () => {} } } })
      }
    },
  }
  apply(ctx)
  assert.equal(definition.name, COMMAND_NAME)
  assert.ok(definition.description.length > 0)

  // No argument lists the choices.
  const listed = definition.handler({ rawInput: '' })
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /当前生效/)

  // Switch by id.
  const byId = definition.handler({ rawInput: 'prompt-1' })
  assert.equal(byId.kind, 'success')
  assert.match(byId.text, /提示词1/)

  // Switch by name.
  const byName = definition.handler({ rawInput: '提示词1' })
  assert.equal(byName.kind, 'success')

  // An unknown reference is an error result, not a throw.
  const missing = definition.handler({ rawInput: '不存在' })
  assert.equal(missing.kind, 'error')

  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

test('pure helpers behave', () => {
  assert.equal(nextPromptId([]), 'prompt-1')
  assert.equal(nextPromptId([{ id: 'prompt-3' }, { id: 'prompt-1' }]), 'prompt-4')
  assert.equal(nextPromptName([{ name: '提示词2' }]), '提示词3')
  assert.equal(uniqueName('副本', [{ name: '副本' }, { name: '副本 2' }]), '副本 3')

  // An activeId pointing at a missing prompt falls back to the first prompt.
  const repaired = normalizeStore({ activeId: 'ghost', prompts: [{ id: 'a', name: 'A' }] })
  assert.equal(repaired.activeId, 'a')
  assert.equal(repaired.prompts.length, 1)
  assert.equal(repaired.prompts[0].content, '')

  // Duplicate ids are dropped rather than trusted.
  const deduped = normalizeStore({ prompts: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] })
  assert.equal(deduped.prompts.length, 1)
  assert.equal(deduped.prompts[0].name, 'A')

  assert.equal(normalizeStore({ prompts: [] }), undefined)
  assert.equal(normalizeStore(null), undefined)
  assert.equal(defaultStore(5).prompts[0].createdAt, 5)
})

test('store file lands next to DSH_HOME as documented', () => {
  const home = tempHome()
  const store = new PromptStore(home)
  store.create()
  const file = resolveStorePath(home)
  assert.equal(file, join(home, '.dsh-system-prompt-store.json'))
  assert.ok(existsSync(file))
  rmSync(home, { recursive: true, force: true })
})
