/**
 * dsh-system-prompt-editor — Host half.
 *
 * Owns four things:
 *  1. the durable prompt store at `<DSH_HOME>/.dsh-system-prompt-store.json`;
 *  2. one `systemPrompt` section (order 800) that injects the active prompt
 *     into every model assembly for the agent that is being assembled;
 *  3. a same-origin JSON RPC route the Settings panel calls;
 *  4. the `/system-prompt-switch` human command.
 *
 * The section `text` callback is synchronous by contract, so it reads only the
 * in-memory cache. Every mutation updates that cache first and then tries the
 * disk; a failed write degrades to memory-only and reports the reason to the UI.
 *
 * `interpolate: false` is deliberate: user prompt text may contain `{{…}}`,
 * and a section that interpolates would throw at assembly time and break the
 * whole system prompt.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-system-prompt-editor'

// `systemPrompt` is the only hard dependency. `webServer` and `commands` are
// optional and resolved through ctx.inject, so the store and the section keep
// working in a profile that composes neither.
export const inject = ['systemPrompt']

/** Section name; the `user:` prefix keeps it clearly outside first-party names. */
export const SECTION_NAME = 'user:custom-system-prompt'
/**
 * Sits after every tool-documentation section (the last is MCP_SERVERS 3100)
 * and before the SDK / structured-output tail (TOOLS_SDK 5000). 4000 is free in
 * the first-party `SECTION_ORDERS` table; ties are broken by name, so reusing a
 * first-party number would place this section unpredictably against it.
 */
export const SECTION_ORDER = 4000
export const STORE_FILENAME = '.dsh-system-prompt-store.json'
export const RPC_PATH = '/plugins/dsh-system-prompt-editor/rpc'
/** Dots are rejected by the command-name grammar, so the separator is a dash. */
export const COMMAND_NAME = 'system-prompt-switch'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_NAME_LENGTH = 120
const DEFAULT_PROMPT_NAME = '提示词1'

export interface PromptRecord {
  id: string
  name: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface PromptStoreData {
  activeId: string
  prompts: PromptRecord[]
}

export interface PersistenceState {
  mode: 'disk' | 'memory'
  file: string
  error: string
}

export interface PromptStoreView extends PromptStoreData {
  persistence: PersistenceState
  createdId?: string
}

/** An Error carrying a stable machine code for the RPC envelope. */
function rpcError(code: string, message: string): Error {
  const error = new Error(message)
  ;(error as { code?: string }).code = code
  return error
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** `$DSH_HOME`, else `~/.dsh` — the same home the rest of the Harness uses. */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

export function resolveStorePath(home: string): string {
  return join(home, STORE_FILENAME)
}

export function defaultStore(now: number = Date.now()): PromptStoreData {
  return {
    activeId: 'prompt-1',
    prompts: [
      { id: 'prompt-1', name: DEFAULT_PROMPT_NAME, content: '', createdAt: now, updatedAt: now },
    ],
  }
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Coerce arbitrary parsed JSON into a usable store.
 * @returns the normalized store, or `undefined` when nothing was salvageable.
 */
export function normalizeStore(raw: unknown): PromptStoreData | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const list = Array.isArray(record.prompts) ? record.prompts : undefined
  if (list === undefined) return undefined

  const now = Date.now()
  const seen = new Set<string>()
  const prompts: PromptRecord[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = asText(row.id).trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const createdAt = asStamp(row.createdAt, now)
    prompts.push({
      id,
      name: asText(row.name, id).slice(0, MAX_NAME_LENGTH),
      content: asText(row.content),
      createdAt,
      updatedAt: asStamp(row.updatedAt, createdAt),
    })
  }
  if (prompts.length === 0) return undefined

  const activeId = asText(record.activeId)
  return {
    activeId: prompts.some((prompt) => prompt.id === activeId) ? activeId : prompts[0]!.id,
    prompts,
  }
}

/** Next `prompt-N` id that is not already taken. */
export function nextPromptId(prompts: readonly PromptRecord[]): string {
  let max = 0
  for (const prompt of prompts) {
    const match = /^prompt-(\d+)$/.exec(prompt.id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  let candidate = max + 1
  const taken = new Set(prompts.map((prompt) => prompt.id))
  while (taken.has(`prompt-${candidate}`)) candidate += 1
  return `prompt-${candidate}`
}

/** Next free `提示词N`, continuing the highest existing number. */
export function nextPromptName(prompts: readonly PromptRecord[]): string {
  let max = 0
  for (const prompt of prompts) {
    const match = /^提示词(\d+)$/.exec(prompt.name.trim())
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  const taken = new Set(prompts.map((prompt) => prompt.name))
  let candidate = max + 1
  while (taken.has(`提示词${candidate}`)) candidate += 1
  return `提示词${candidate}`
}

/** `base`, else `base 2`, `base 3`… — used for duplicate copies. */
export function uniqueName(base: string, prompts: readonly PromptRecord[]): string {
  const taken = new Set(prompts.map((prompt) => prompt.name))
  if (!taken.has(base)) return base
  let index = 2
  while (taken.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, file)
}

/**
 * In-memory prompt store with best-effort disk persistence.
 * Constructed once per plugin activation.
 */
export class PromptStore {
  readonly file: string
  private data: PromptStoreData
  private persistence: PersistenceState

  constructor(home: string, now: number = Date.now()) {
    this.file = resolveStorePath(home)
    this.persistence = { mode: 'disk', file: this.file, error: '' }
    const loaded = this.loadFromDisk(now)
    this.data = loaded.data
    if (loaded.error !== '') this.persistence = { mode: 'disk', file: this.file, error: loaded.error }
  }

  private loadFromDisk(now: number): { data: PromptStoreData; error: string } {
    if (!existsSync(this.file)) return { data: defaultStore(now), error: '' }
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      return { data: defaultStore(now), error: `读取失败，已使用默认数据：${errorMessage(error)}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // Keep the unreadable file instead of silently destroying it.
      const backup = `${this.file}.corrupt-${now}`
      try {
        renameSync(this.file, backup)
      } catch {
        /* the backup is best effort; the store still starts from defaults */
      }
      return {
        data: defaultStore(now),
        error: `解析失败，已备份为 ${backup} 并重建默认数据：${errorMessage(error)}`,
      }
    }
    const normalized = normalizeStore(parsed)
    if (normalized === undefined) {
      return { data: defaultStore(now), error: '数据结构无效，已重建默认数据' }
    }
    return { data: normalized, error: '' }
  }

  /** Persist the current cache. @returns the failure message, or `''` on success. */
  private persist(): string {
    try {
      writeAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`)
      this.persistence = { mode: 'disk', file: this.file, error: '' }
      return ''
    } catch (error) {
      const message = errorMessage(error)
      this.persistence = { mode: 'memory', file: this.file, error: message }
      return message
    }
  }

  get active(): PromptRecord | undefined {
    return this.data.prompts.find((prompt) => prompt.id === this.data.activeId)
  }

  get activeContent(): string {
    return this.active?.content ?? ''
  }

  view(createdId?: string): PromptStoreView {
    return {
      activeId: this.data.activeId,
      prompts: this.data.prompts.map((prompt) => ({ ...prompt })),
      persistence: { ...this.persistence },
      ...(createdId === undefined ? {} : { createdId }),
    }
  }

  private require(id: unknown): PromptRecord {
    const key = asText(id).trim()
    if (key.length === 0) throw rpcError('invalid-argument', '缺少提示词 id')
    const found = this.data.prompts.find((prompt) => prompt.id === key)
    if (found === undefined) throw rpcError('not-found', `未找到提示词 ${key}`)
    return found
  }

  getActive(): { id: string; name: string; content: string } | null {
    const active = this.active
    if (active === undefined) return null
    return { id: active.id, name: active.name, content: active.content }
  }

  create(): PromptStoreView {
    const now = Date.now()
    const prompt: PromptRecord = {
      id: nextPromptId(this.data.prompts),
      name: nextPromptName(this.data.prompts),
      content: '',
      createdAt: now,
      updatedAt: now,
    }
    this.data.prompts.push(prompt)
    this.persist()
    return this.view(prompt.id)
  }

  rename(id: unknown, rawName: unknown): PromptStoreView {
    const prompt = this.require(id)
    const next = asText(rawName).trim()
    if (next.length === 0) throw rpcError('invalid-argument', '名称不能为空')
    if (next.length > MAX_NAME_LENGTH) throw rpcError('invalid-argument', `名称不能超过 ${MAX_NAME_LENGTH} 个字符`)
    prompt.name = next
    prompt.updatedAt = Date.now()
    this.persist()
    return this.view()
  }

  update(id: unknown, content: unknown): PromptStoreView {
    const prompt = this.require(id)
    prompt.content = asText(content)
    prompt.updatedAt = Date.now()
    this.persist()
    return this.view()
  }

  activate(id: unknown): PromptStoreView {
    const prompt = this.require(id)
    this.data.activeId = prompt.id
    this.persist()
    return this.view()
  }

  duplicate(id: unknown): PromptStoreView {
    const source = this.require(id)
    const now = Date.now()
    const prompt: PromptRecord = {
      id: nextPromptId(this.data.prompts),
      name: uniqueName(`${source.name} 副本`, this.data.prompts),
      content: source.content,
      createdAt: now,
      updatedAt: now,
    }
    this.data.prompts.push(prompt)
    this.persist()
    return this.view(prompt.id)
  }

  remove(id: unknown): PromptStoreView {
    const prompt = this.require(id)
    if (this.data.prompts.length <= 1) throw rpcError('last-prompt', '最后一个提示词不能删除')
    this.data.prompts = this.data.prompts.filter((entry) => entry.id !== prompt.id)
    // Deleting the active prompt falls back to the first remaining one.
    if (this.data.activeId === prompt.id) this.data.activeId = this.data.prompts[0]!.id
    this.persist()
    return this.view()
  }

  /** Resolve a prompt by id first, then by exact name. */
  resolve(reference: string): PromptRecord {
    const key = reference.trim()
    if (key.length === 0) throw rpcError('invalid-argument', '请提供提示词名称或 id')
    const byId = this.data.prompts.find((prompt) => prompt.id === key)
    if (byId !== undefined) return byId
    const byName = this.data.prompts.filter((prompt) => prompt.name === key)
    if (byName.length === 1) return byName[0]!
    if (byName.length > 1) {
      throw rpcError('ambiguous-name', `有 ${byName.length} 个同名提示词，请改用 id：${byName.map((prompt) => prompt.id).join(', ')}`)
    }
    throw rpcError('not-found', `未找到提示词 ${key}`)
  }

  describe(): string {
    const active = this.active
    const lines = this.data.prompts.map((prompt) => `${prompt.id === this.data.activeId ? '*' : ' '} ${prompt.name} (${prompt.id})`)
    return [`当前生效：${active?.name ?? '(无)'}`, ...lines].join('\n')
  }
}

function headerOf(request: { headers?: Record<string, unknown> } | undefined, key: string): string {
  const headers = request?.headers
  if (headers === undefined) return ''
  const value = headers[key] ?? headers[key.toLowerCase()]
  if (Array.isArray(value)) return String(value[0] ?? '')
  return String(value ?? '')
}

function sendJson(response: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(body)
}

/** Reject cross-origin and non-loopback-adjacent callers, mirroring shipped plugins. */
function allowSameOrigin(request: { headers?: Record<string, unknown> }, response: never | { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }): boolean {
  if (headerOf(request, 'sec-fetch-site').toLowerCase() === 'cross-site') {
    sendJson(response as never, 403, { ok: false, error: { code: 'cross-origin', message: 'cross-origin blocked' } })
    return false
  }
  const origin = headerOf(request, 'origin').trim()
  if (origin === 'null') {
    sendJson(response as never, 403, { ok: false, error: { code: 'cross-origin', message: 'opaque origin blocked' } })
    return false
  }
  if (origin === '') return true
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    sendJson(response as never, 403, { ok: false, error: { code: 'cross-origin', message: 'malformed origin' } })
    return false
  }
  const host = headerOf(request, 'host').trim()
  if (host === '' || originHost.toLowerCase() !== host.toLowerCase()) {
    sendJson(response as never, 403, { ok: false, error: { code: 'cross-origin', message: 'cross-origin blocked' } })
    return false
  }
  return true
}

function readBody(request: AsyncIterable<Uint8Array> & { on: (event: string, listener: (...args: never[]) => void) => void; destroy?: () => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', ((chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(rpcError('payload-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节`))
        request.destroy?.()
        return
      }
      chunks.push(chunk)
    }) as never)
    request.on('end', (() => resolve(Buffer.concat(chunks).toString('utf8'))) as never)
    request.on('error', ((error: Error) => reject(error)) as never)
  })
}

/**
 * Host half entry point.
 * @param ctx - the plugin context; `systemPrompt` is injected by the declaration above.
 */
export function apply(ctx: {
  effect: (callback: () => unknown, label?: string) => unknown
  systemPrompt: { section: (section: { name: string; order: number; interpolate: boolean; text: (context: { agent?: unknown }) => string }) => unknown }
  inject: (names: string[], callback: (host: never) => void) => unknown
}): void {
  const store = new PromptStore(resolveDshHome())

  // (e) The injection section. Synchronous, cache-only, empty text is dropped
  // by the renderer so an empty prompt never pollutes the system prompt.
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        interpolate: false,
        text: (context: { agent?: unknown }) => {
          if (context === undefined || context === null) return ''
          if (context.agent === undefined) return ''
          const content = store.activeContent
          return content.trim().length > 0 ? content : ''
        },
      }),
    'system-prompt-editor: active prompt section',
  )

  const handlers: Record<string, (params: Record<string, unknown>) => PromptStoreView | { id: string; name: string; content: string } | null> = {
    'system-prompt/list': () => store.view(),
    'system-prompt/get-active': () => store.getActive(),
    'system-prompt/create': () => store.create(),
    'system-prompt/rename': (params) => store.rename(params.id, params.name),
    'system-prompt/update': (params) => store.update(params.id, params.content),
    'system-prompt/delete': (params) => store.remove(params.id),
    'system-prompt/activate': (params) => store.activate(params.id),
    'system-prompt/switch': (params) => store.activate(params.id),
    'system-prompt/duplicate': (params) => store.duplicate(params.id),
  }

  // (c) One same-origin RPC route. Every method keeps the `system-prompt/`
  // prefix, so the namespace cannot collide with another plugin's route.
  ctx.inject(['webServer'], ((host: {
    effect: (callback: () => unknown, label?: string) => unknown
    webServer: { register: (route: { kind: string; path: string; handler: (req: never, res: never) => unknown }) => unknown }
  }) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: RPC_PATH,
          handler: async (request: never, response: never) => {
            const req = request as unknown as { method?: string; headers?: Record<string, unknown> } & Parameters<typeof readBody>[0]
            const res = response as unknown as Parameters<typeof sendJson>[1]
            if (!allowSameOrigin(req, res)) return
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
              return
            }
            let payload: { method?: unknown; params?: unknown }
            try {
              payload = JSON.parse((await readBody(req)) || '{}') as { method?: unknown; params?: unknown }
            } catch (error) {
              sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: errorMessage(error) } })
              return
            }
            const method = typeof payload.method === 'string' ? payload.method : ''
            const handler = handlers[method]
            if (handler === undefined) {
              sendJson(res, 404, {
                ok: false,
                error: { code: 'method-not-found', message: `未知的 RPC 方法 ${JSON.stringify(method)}` },
              })
              return
            }
            try {
              const params = typeof payload.params === 'object' && payload.params !== null ? (payload.params as Record<string, unknown>) : {}
              sendJson(res, 200, { ok: true, value: handler(params) })
            } catch (error) {
              const code = (error as { code?: string }).code ?? 'rpc-error'
              sendJson(res, 200, { ok: false, error: { code, message: errorMessage(error) } })
            }
          },
        }),
      'system-prompt-editor: RPC route',
    )
  }) as never)

  // (f) `/system-prompt-switch [名称或 id]` — empty input lists the choices.
  ctx.inject(['commands'], ((host: {
    effect: (callback: () => unknown, label?: string) => unknown
    commands: { register: (definition: Record<string, unknown>) => unknown }
  }) => {
    host.effect(
      () =>
        host.commands.register({
          definitionId: 'dsh-system-prompt-editor',
          name: COMMAND_NAME,
          description: '切换当前生效的系统提示词（参数为名称或 id）',
          input: { hint: '[提示词名称或 id]' },
          handler: (invocation: { rawInput?: string }) => {
            const reference = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
            if (reference.length === 0) return { kind: 'success', text: store.describe() }
            try {
              const prompt = store.resolve(reference)
              store.activate(prompt.id)
              const persistence = store.view().persistence
              const suffix = persistence.mode === 'memory' ? `（仅内存生效：${persistence.error}）` : ''
              return { kind: 'success', text: `已切换系统提示词：${prompt.name}${suffix}` }
            } catch (error) {
              return { kind: 'error', text: errorMessage(error) }
            }
          },
        }),
      'system-prompt-editor: switch command',
    )
  }) as never)
}
