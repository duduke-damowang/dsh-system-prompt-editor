// dsh-system-prompt-editor — Client half.
//
// Registers one `settings.section` page. This file is plain JavaScript on
// purpose: the Host serves it to the browser verbatim, so it contains no JSX
// and no TypeScript. React arrives from the browser module table, and all
// styling uses `--dsw-alias-*` theme tokens so the panel follows the host's
// light and dark themes.
//
// Transport is the Host's same-origin JSON route at RPC_PATH: one POST per
// operation carrying `{ method, params }`.
window.__ModuleLoader__.load({
  id: 'dsh-system-prompt-editor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const RPC_PATH = '/plugins/dsh-system-prompt-editor/rpc'
    const SECTION_ID = 'system-prompt-editor'
    // Nav position: after General (0), Models (10), Plugins (15), Agent presets (20).
    const SECTION_ORDER = 30

    /** One RPC round trip; rejects with the Host's message. */
    async function call(method, params, signal) {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params === undefined ? { method } : { method, params }),
        signal,
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error?.message || `HTTP ${response.status}`)
      }
      return body.value
    }

    // One scoped stylesheet for the list rows. Inline styles cannot express
    // :hover / :focus-visible, and the selected row needs a border that is
    // actually visible — `--dsw-alias-border-l1` is 6% alpha, so a selected
    // row looked *less* framed than its neighbours.
    const STYLE_ID = 'dsh-system-prompt-editor-style'
    const PANEL_CSS = [
      // Matches the harness's own selected-row convention: a ghost-active fill
      // plus an inset ring, which stays visible in both light and dark themes.
      // `--dsw-alias-border-l1` is 6% alpha and reads as *less* framed than the
      // unselected rows, which is what the border-color approach got wrong.
      '.spe-item{border:0;background:transparent;box-shadow:inset 0 0 0 1px transparent;transition:background 120ms ease,box-shadow 120ms ease}',
      '.spe-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.spe-item[data-selected="true"]{background:var(--dsw-alias-button-ghost-active-fill);box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}',
      '.spe-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('\n')

    /** Install the stylesheet once per document. */
    function ensurePanelStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = PANEL_CSS
      document.head.appendChild(element)
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg)', padding: 16, background: 'var(--dsw-alias-bg-base)' },
      heading: { fontSize: 14, fontWeight: 500, margin: 0 },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px', margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      columns: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' },
      list: { flex: '1 1 200px', minWidth: 180, display: 'flex', flexDirection: 'column', gap: 4 },
      editor: { flex: '2 1 320px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 10 },
      item: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 'var(--dsw-radius-md)', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      badge: { flex: 'none', fontSize: 11, lineHeight: '16px', padding: '1px 6px', borderRadius: 'var(--dsw-radius-sm)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)' },
      input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 'var(--dsw-radius-md)', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)', color: 'inherit', font: 'inherit' },
      textarea: { width: '100%', boxSizing: 'border-box', minHeight: 220, resize: 'vertical', padding: '10px 12px', borderRadius: 'var(--dsw-radius-md)', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)', color: 'inherit', font: 'inherit', lineHeight: '22px' },
      button: { padding: '6px 12px', borderRadius: 'var(--dsw-radius-md)', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      buttonPrimary: { borderColor: 'transparent', background: 'var(--dsw-alias-interactive-bg-hover)' },
      buttonDanger: { color: 'var(--dsw-alias-state-error-primary)' },
      status: { fontSize: 12, lineHeight: '18px', minHeight: 18, margin: 0 },
      select: { padding: '6px 10px', borderRadius: 'var(--dsw-radius-md)', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)', color: 'inherit', font: 'inherit', minWidth: 180 },
    }

    const disabledStyle = { opacity: 0.5, cursor: 'not-allowed' }

    function button(label, onClick, options) {
      const opts = options || {}
      const style = Object.assign(
        {},
        styles.button,
        opts.primary ? styles.buttonPrimary : null,
        opts.danger ? styles.buttonDanger : null,
        opts.disabled ? disabledStyle : null,
        opts.style || null,
      )
      return h('button', {
        type: 'button',
        onClick,
        disabled: Boolean(opts.disabled),
        style,
        title: opts.title,
        'aria-label': opts.ariaLabel || label,
      }, label)
    }

    function SystemPromptSection() {
      const [view, setView] = React.useState(null)
      const [selectedId, setSelectedId] = React.useState(null)
      const [name, setName] = React.useState('')
      const [content, setContent] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const nameRef = React.useRef(null)
      const focusNameRef = React.useRef(false)

      const prompts = view ? view.prompts : []
      const selected = prompts.find(function (prompt) { return prompt.id === selectedId }) || null
      const active = prompts.find(function (prompt) { return prompt.id === (view && view.activeId) }) || null
      const memoryOnly = Boolean(view && view.persistence && view.persistence.mode === 'memory')

      /** Adopt a Host view and re-seed the editor from the selected record. */
      const adopt = React.useCallback(function (next, options) {
        const opts = options || {}
        setView(next)
        const list = next.prompts || []
        const keep = list.some(function (prompt) { return prompt.id === selectedId })
        const requested = opts.selectId && list.some(function (prompt) { return prompt.id === opts.selectId }) ? opts.selectId : null
        const targetId = requested || (keep ? selectedId : (list[0] ? list[0].id : null))
        setSelectedId(targetId)
        const record = list.find(function (prompt) { return prompt.id === targetId })
        setName(record ? record.name : '')
        setContent(record ? record.content : '')
        if (opts.focusName) focusNameRef.current = true
        if (next.persistence && next.persistence.mode === 'memory' && !opts.quiet) {
          setStatus({ tone: 'warn', text: '保存失败，仅内存生效：' + (next.persistence.error || '未知原因') })
        }
      }, [selectedId])

      /** Run one RPC mutation with shared busy and status handling. */
      const run = React.useCallback(async function (method, params, options) {
        const opts = options || {}
        setBusy(true)
        setStatus(null)
        try {
          const next = await call(method, params)
          adopt(next, opts)
          if (opts.success) setStatus({ tone: 'ok', text: opts.success })
          return next
        } catch (error) {
          setStatus({ tone: 'error', text: String(error.message || error) })
          return null
        } finally {
          setBusy(false)
        }
      }, [adopt])

      // Initial load.
      React.useEffect(function () {
        let cancelled = false
        const controller = new AbortController()
        call('system-prompt/list', undefined, controller.signal).then(function (next) {
          if (cancelled) return
          setLoadError('')
          adopt(next, { quiet: true })
          if (next.persistence && next.persistence.mode === 'memory') {
            setStatus({ tone: 'warn', text: '磁盘写入不可用，当前仅内存生效：' + (next.persistence.error || '未知原因') })
          }
        }, function (error) {
          if (cancelled) return
          setLoadError(String(error.message || error))
        })
        return function () {
          cancelled = true
          controller.abort()
        }
        // Mount-only: the first read seeds every other piece of state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // Focus the name field right after a prompt is created.
      React.useEffect(function () {
        if (focusNameRef.current && nameRef.current) {
          focusNameRef.current = false
          nameRef.current.focus()
          nameRef.current.select()
        }
      }, [selectedId, prompts.length])

      function selectRow(prompt) {
        // Selecting loads the editor only; it never switches the active prompt.
        setSelectedId(prompt.id)
        setName(prompt.name)
        setContent(prompt.content)
        setConfirmDelete(false)
        setStatus(null)
      }

      function createPrompt() {
        run('system-prompt/create', undefined, { focusName: true, success: '已新增提示词' })
      }

      function duplicatePrompt() {
        if (!selected) return
        run('system-prompt/duplicate', { id: selected.id }, { success: '已复制「' + selected.name + '」' })
      }

      function activatePrompt(id) {
        run('system-prompt/activate', { id }, { success: '已切换，后续对话生效' })
      }

      function savePrompt() {
        if (!selected) return
        const trimmed = name.trim()
        if (trimmed.length === 0) {
          setStatus({ tone: 'error', text: '名称不能为空' })
          return
        }
        // Content first, then the name, so one Save commits both fields.
        setBusy(true)
        setStatus(null)
        call('system-prompt/update', { id: selected.id, content })
          .then(function (afterContent) {
            if (trimmed === selected.name) {
              adopt(afterContent)
              setStatus({ tone: 'ok', text: '已保存' })
              return null
            }
            return call('system-prompt/rename', { id: selected.id, name: trimmed }).then(function (afterName) {
              adopt(afterName)
              setStatus({ tone: 'ok', text: '已保存' })
            })
          })
          .catch(function (error) {
            setStatus({ tone: 'error', text: '保存失败：' + String(error.message || error) })
          })
          .then(function () { setBusy(false) })
      }

      function deletePrompt() {
        if (!selected) return
        if (prompts.length <= 1) {
          setStatus({ tone: 'error', text: '最后一个提示词不能删除' })
          return
        }
        if (!confirmDelete) {
          // Two-step confirmation; a second click is required to delete.
          setConfirmDelete(true)
          setStatus({ tone: 'warn', text: '再次点击「确认删除」以删除「' + selected.name + '」' })
          return
        }
        setConfirmDelete(false)
        run('system-prompt/delete', { id: selected.id }, { success: '已删除「' + selected.name + '」' })
      }

      if (loadError) {
        return h('div', { style: styles.page },
          h('h2', { style: styles.heading }, '系统提示词'),
          h('p', {
            role: 'alert',
            style: Object.assign({}, styles.status, { color: 'var(--dsw-alias-state-error-primary)' }),
          }, '加载失败：' + loadError),
          button('重试', function () {
            setLoadError('')
            call('system-prompt/list').then(function (next) {
              adopt(next, { quiet: true })
            }, function (error) {
              setLoadError(String(error.message || error))
            })
          }))
      }

      if (!view) {
        return h('div', { style: styles.page }, h('p', { style: styles.hint }, '正在加载…'))
      }

      return h('div', { style: styles.page },
        h('div', null,
          h('h2', { style: styles.heading }, '系统提示词'),
          h('p', { style: styles.hint }, '维护多套系统提示词，随时切换当前生效项。切换后立即生效于后续每次模型装配。')),

        // Quick switch: the dropdown is the one-click path.
        h('div', { style: Object.assign({}, styles.card, styles.row) },
          h('span', { style: { fontWeight: 500 } }, '当前生效：'),
          h('span', { 'data-testid': 'active-prompt-name' }, active ? active.name : '(无)'),
          h('label', { style: Object.assign({}, styles.row, { marginLeft: 'auto' }) },
            h('span', { style: styles.hint }, '快速切换'),
            h('select', {
              style: styles.select,
              value: view.activeId,
              disabled: busy,
              'aria-label': '快速切换系统提示词',
              onChange: function (event) { activatePrompt(event.target.value) },
            }, prompts.map(function (prompt) {
              return h('option', { key: prompt.id, value: prompt.id }, prompt.name)
            })))),

        status ? h('p', {
          role: status.tone === 'error' ? 'alert' : 'status',
          style: Object.assign({}, styles.status, {
            color: status.tone === 'error' ? 'var(--dsw-alias-state-error-primary)'
              : status.tone === 'ok' ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-warn-primary)',
          }),
        }, status.text) : null,

        memoryOnly ? h('p', {
          style: Object.assign({}, styles.hint, { color: 'var(--dsw-alias-state-warn-primary)' }),
        }, '磁盘写入不可用，修改仅保存在内存中，重启后丢失。') : null,

        h('div', { style: styles.columns },
          // Prompt list.
          h('div', { style: Object.assign({}, styles.card, styles.list) },
            prompts.map(function (prompt) {
              const isActive = prompt.id === view.activeId
              const isSelected = prompt.id === selectedId
              return h('button', {
                key: prompt.id,
                type: 'button',
                'aria-current': isActive ? 'true' : undefined,
                className: 'spe-item',
                'data-selected': isSelected ? 'true' : undefined,
                style: styles.item,
                onClick: function () { selectRow(prompt) },
              },
                h('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, prompt.name),
                isActive ? h('span', { style: styles.badge }, '当前') : null)
            }),
            h('div', { style: Object.assign({}, styles.row, { marginTop: 8 }) },
              button('新增', createPrompt, { disabled: busy, primary: true }),
              button('复制', duplicatePrompt, { disabled: busy || !selected }),
              button(confirmDelete ? '确认删除' : '删除', deletePrompt, {
                disabled: busy || !selected || prompts.length <= 1,
                danger: true,
                title: prompts.length <= 1 ? '最后一个提示词不能删除' : '删除选中的提示词',
              }))),

          // Editor for the selected prompt.
          h('div', { style: Object.assign({}, styles.card, styles.editor) },
            selected ? h('div', { style: styles.row },
              h('span', { style: { fontWeight: 500 } }, '编辑：'),
              h('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, selected.name),
              selected.id === view.activeId
                ? h('span', { style: styles.badge }, '当前生效')
                : button('设为当前', function () { activatePrompt(selected.id) }, { disabled: busy, primary: true }),
              h('span', { style: styles.hint }, selected.id)) : null,

            h('label', { style: { display: 'block' } },
              h('span', {
                style: Object.assign({}, styles.hint, { display: 'block', marginBottom: 4 }),
              }, '名称'),
              h('input', {
                ref: nameRef,
                type: 'text',
                value: name,
                maxLength: 120,
                disabled: busy || !selected,
                style: styles.input,
                'aria-label': '提示词名称',
                onChange: function (event) {
                  setName(event.target.value)
                  setConfirmDelete(false)
                },
              })),

            h('label', { style: { display: 'block' } },
              h('span', {
                style: Object.assign({}, styles.hint, { display: 'block', marginBottom: 4 }),
              }, '内容（为空时不注入）'),
              h('textarea', {
                value: content,
                disabled: busy || !selected,
                style: styles.textarea,
                'aria-label': '提示词内容',
                placeholder: '在此输入该套系统提示词的内容…',
                onChange: function (event) {
                  setContent(event.target.value)
                  setConfirmDelete(false)
                },
              })),

            h('div', { style: styles.row },
              button('保存', savePrompt, { disabled: busy || !selected, primary: true }),
              h('span', { style: styles.hint }, '保存会同时提交名称与内容')))),

        h('p', { style: styles.hint },
          '也可在命令面板执行 /system-prompt-switch <名称或 id> 快速切换（不带参数则列出全部）。'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensurePanelStyle()
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: function () { return '系统提示词' },
          }, SystemPromptSection)
        })
      },
    }
  },
})
