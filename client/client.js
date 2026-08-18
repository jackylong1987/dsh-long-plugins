window.__ModuleLoader__.load({
  id: 'dsh-long-plugins',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ===== dsh-file-uploads: upload manager + workspace 输出文件 section =====
    const uploadPlugin = (() => {

    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const API_PATH = '/api/dsh-uploads'
    const DOWNLOAD_PATH = '/api/dsh-uploads/download'
    const PREVIEW_PATH = '/api/dsh-uploads/preview'
    const SOURCE = 'local-upload-files'
    const HIDDEN_LABEL = '__dsh_upload_hidden__:'

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function responseJson(response) {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    async function uploadFile(file) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      })
      return (await responseJson(response)).file
    }

    function downloadUrl(name) {
      return `${DOWNLOAD_PATH}?name=${encodeURIComponent(name)}`
    }

    function previewUrl(name) {
      return `${PREVIEW_PATH}?name=${encodeURIComponent(name)}`
    }

    function modelLine(file) {
      return `上传文件：\`${file.path}\``
    }

    function serializedFile(file) {
      return `\n${modelLine(file)}`
    }

    function stripSerializedFiles(draft, files) {
      const lines = new Set(files.map(modelLine))
      return String(draft || '')
        .split('\n')
        .filter((line) => !lines.has(line.trim()))
        .join('\n')
        .replace(/^\n+|\n+$/g, '')
    }

    function legacyUploadPaths(draft) {
      const paths = []
      for (const line of String(draft || '').split('\n')) {
        const match = line.trim().match(/^上传文件：\s*`([^`]+)`$/)
        if (match) paths.push(match[1])
      }
      return paths
    }

    function stripLegacyPaths(draft, paths) {
      const remove = new Set(paths)
      return String(draft || '')
        .split('\n')
        .filter((line) => {
          const match = line.trim().match(/^上传文件：\s*`([^`]+)`$/)
          return !match || !remove.has(match[1])
        })
        .join('\n')
        .replace(/^\n+|\n+$/g, '')
    }

    class FileDraftController {
      constructor(ctx) {
        this.ctx = ctx
        this.pending = new Map()
        this.inFlight = new Map()
        this.refIndex = new Map()
        this.listeners = new Map()
        this.expiry = new Map()
        this.serializing = new Set()
        this.migrated = new Set()
        this.counter = 0
      }

      pendingFor(sessionId) {
        return this.pending.get(String(sessionId)) || []
      }

      subscribe(sessionId, listener) {
        const key = String(sessionId)
        let set = this.listeners.get(key)
        if (!set) {
          set = new Set()
          this.listeners.set(key, set)
        }
        set.add(listener)
        return () => {
          set.delete(listener)
          if (set.size === 0) this.listeners.delete(key)
        }
      }

      publish(sessionId) {
        const set = this.listeners.get(String(sessionId))
        if (!set) return
        for (const listener of set) listener()
      }

      scope(sessionId) {
        const actx = this.ctx.sessions.scope(sessionId)
        if (!actx) throw new Error('当前会话尚未就绪')
        return { actx, shell: this.ctx.conversation.input.for(actx) }
      }

      insertReference(sessionId, entry) {
        const { actx, shell } = this.scope(sessionId)
        const input = shell.snapshot
        if (!input || input.phase !== 'plain') return false
        return actx.bail(actx, 'slash/input-insert-reference', {
          reference: {
            source: SOURCE,
            ref: entry.ref,
            label: `${HIDDEN_LABEL}${entry.ref}`,
            clipboardText: '',
          },
          span: {
            start: input.draft.length,
            end: input.draft.length,
            draftRev: input.draftRev,
          },
        }) === true
      }

      attach(sessionId, file) {
        const key = String(sessionId)
        this.clearInFlight(key)
        const entry = { ...file, ref: `${key}-${++this.counter}` }
        if (!this.insertReference(sessionId, entry)) {
          throw new Error('输入框正忙，请稍后重新选择该文件')
        }
        const next = [...this.pendingFor(key), entry]
        this.pending.set(key, next)
        this.refIndex.set(entry.ref, { sessionId: key, entry })
        this.publish(key)
        return entry
      }

      remove(sessionId, ref) {
        const key = String(sessionId)
        const entries = this.pendingFor(key)
        const entry = entries.find((item) => item.ref === ref)
        if (!entry) return
        const { shell } = this.scope(sessionId)
        const input = shell.snapshot
        const occurrence = input.occurrences.find((item) => item.source === SOURCE && item.ref === ref)
        if (occurrence) {
          shell.setDraft(input.draft.slice(0, occurrence.offset) + input.draft.slice(occurrence.offset + 1))
        }
        const next = entries.filter((item) => item.ref !== ref)
        if (next.length > 0) this.pending.set(key, next)
        else this.pending.delete(key)
        this.refIndex.delete(ref)
        this.publish(key)
      }

      fileForRef(ref) {
        return this.refIndex.get(ref)?.entry
      }

      markSerializing(ref) {
        const record = this.refIndex.get(ref)
        if (record) this.serializing.add(record.sessionId)
      }

      reconcile(sessionId, occurrences) {
        const key = String(sessionId)
        const entries = this.pendingFor(key)
        if (entries.length === 0) return
        const refs = new Set(
          (occurrences || [])
            .filter((item) => item.source === SOURCE)
            .map((item) => item.ref),
        )
        const missing = entries.filter((entry) => !refs.has(entry.ref))
        if (missing.length === 0) return

        if (this.serializing.delete(key)) {
          this.pending.delete(key)
          this.inFlight.set(key, entries)
          const previous = this.expiry.get(key)
          if (previous) previous()
          this.expiry.set(key, this.ctx.timeout(() => this.clearInFlight(key), 30_000))
          this.publish(key)
          return
        }

        for (const entry of missing) this.refIndex.delete(entry.ref)
        const next = entries.filter((entry) => refs.has(entry.ref))
        if (next.length > 0) this.pending.set(key, next)
        else this.pending.delete(key)
        this.publish(key)
      }

      restoreFailed(sessionId) {
        const key = String(sessionId)
        const entries = this.inFlight.get(key)
        if (!entries || entries.length === 0) return
        const expiry = this.expiry.get(key)
        if (expiry) expiry()
        this.expiry.delete(key)
        this.inFlight.delete(key)

        const { shell } = this.scope(sessionId)
        const cleaned = stripSerializedFiles(shell.snapshot.draft, entries)
        shell.setDraft(cleaned)

        const restored = []
        for (const entry of entries) {
          if (this.insertReference(sessionId, entry)) restored.push(entry)
          else this.refIndex.delete(entry.ref)
        }
        if (restored.length > 0) this.pending.set(key, restored)
        this.publish(key)
      }

      clearInFlight(sessionId) {
        const key = String(sessionId)
        const expiry = this.expiry.get(key)
        if (expiry) expiry()
        this.expiry.delete(key)
        const entries = this.inFlight.get(key) || []
        for (const entry of entries) this.refIndex.delete(entry.ref)
        this.inFlight.delete(key)
      }

      async migrateLegacy(sessionId, draft) {
        const key = String(sessionId)
        if (this.migrated.has(key)) return
        this.migrated.add(key)
        const paths = legacyUploadPaths(draft)
        if (paths.length === 0) return

        try {
          const body = await responseJson(await fetch(API_PATH, { cache: 'no-store' }))
          const wanted = new Set(paths)
          const files = body.files.filter((file) => wanted.has(file.path))
          if (files.length === 0) return
          const { shell } = this.scope(sessionId)
          shell.setDraft(stripLegacyPaths(shell.snapshot.draft, files.map((file) => file.path)))
          for (const file of files) this.attach(sessionId, file)
        } catch (error) {
          console.error('[dsh-upload-manager] legacy draft migration failed', error)
        }
      }

      dispose() {
        for (const cancel of this.expiry.values()) cancel()
        this.expiry.clear()
        this.pending.clear()
        this.inFlight.clear()
        this.refIndex.clear()
        this.listeners.clear()
        this.serializing.clear()
        this.migrated.clear()
      }
    }

    function usePending(controller, sessionId) {
      const [, render] = React.useState(0)
      React.useEffect(
        () => controller.subscribe(sessionId, () => render((value) => value + 1)),
        [controller, sessionId],
      )
      return controller.pendingFor(sessionId)
    }

    function PaperclipIcon() {
      return React.createElement(
        'svg',
        {
          className: 'dsh-upload-icon',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' }),
      )
    }

    function UploadControl(props) {
      const input = props.useInput((state) => state) || props.input
      const pickerRef = React.useRef(null)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('')

      async function onPick(event) {
        const files = Array.from(event.currentTarget.files || [])
        event.currentTarget.value = ''
        if (files.length === 0) return

        setBusy(true)
        setStatus(`正在上传 ${files.length} 个文件…`)
        let attached = 0
        const failures = []
        try {
          for (const file of files) {
            try {
              const stored = await uploadFile(file)
              props.controller.attach(props.sessionId, stored)
              attached += 1
            } catch (error) {
              failures.push(`${file.name}: ${errorMessage(error)}`)
            }
          }
          setStatus(failures.length === 0
            ? `已添加 ${attached} 个待发送文件`
            : `已添加 ${attached} 个，失败 ${failures.length} 个：${failures.join('；')}`)
        } finally {
          setBusy(false)
        }
      }

      const disabled = busy || !input || input.phase !== 'plain'
      return React.createElement(
        'div',
        { className: 'dsh-upload-control', title: status || '上传本地文件并加入本次消息' },
        React.createElement('input', {
          ref: pickerRef,
          className: 'dsh-upload-picker',
          type: 'file',
          multiple: true,
          onChange: onPick,
        }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-upload-button',
            disabled,
            'aria-label': busy ? '正在上传文件' : '上传文件',
            title: status || '上传本地文件并加入本次消息',
            onClick: () => pickerRef.current?.click(),
          },
          React.createElement(PaperclipIcon, null),
        ),
        React.createElement('span', { className: 'dsh-upload-live', 'aria-live': 'polite' }, status),
      )
    }

    function PendingFileRail(props) {
      const input = props.useInput((state) => state)
      const promptError = props.useSession((session) => session.promptError) || null
      const files = usePending(props.controller, props.sessionId)

      React.useEffect(() => {
        props.controller.migrateLegacy(props.sessionId, input?.draft || '')
        props.controller.reconcile(props.sessionId, input?.occurrences || [])
      }, [props.controller, props.sessionId, input?.draftRev])

      React.useEffect(() => {
        if (promptError) props.controller.restoreFailed(props.sessionId)
      }, [props.controller, props.sessionId, promptError])

      if (files.length === 0) return null
      return React.createElement(
        'div',
        { className: 'dsh-upload-rail', 'aria-label': '待发送文件' },
        files.map((file) => React.createElement(
          'div',
          { className: 'dsh-upload-chip', key: file.ref },
          React.createElement('span', { className: 'dsh-upload-chip-icon', 'aria-hidden': true }, '▤'),
          React.createElement(
            'span',
            { className: 'dsh-upload-chip-copy' },
            React.createElement('strong', { title: file.name }, file.name),
            React.createElement('small', null, sizeText(file.size)),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              'aria-label': `移除 ${file.name}`,
              title: '从本次消息移除',
              onClick: () => props.controller.remove(props.sessionId, file.ref),
            },
            '×',
          ),
        )),
      )
    }

    function sizeText(bytes) {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
      return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
    }

    function dateText(value) {
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(value))
      } catch {
        return value
      }
    }

    function UploadSettingsSection() {
      const [state, setState] = React.useState({
        loading: true,
        root: '',
        maxFileBytes: 0,
        totalMaxBytes: 0,
        usedBytes: 0,
        files: [],
        error: '',
      })
      const [deleting, setDeleting] = React.useState('')
      const [preview, setPreview] = React.useState(null)
      const [previewMaximized, setPreviewMaximized] = React.useState(false)

      async function refresh() {
        setState((current) => ({ ...current, loading: true, error: '' }))
        try {
          const response = await fetch(API_PATH, { cache: 'no-store' })
          const body = await responseJson(response)
          setState({
            loading: false,
            root: body.root,
            maxFileBytes: body.maxFileBytes,
            totalMaxBytes: body.totalMaxBytes,
            usedBytes: body.usedBytes,
            files: body.files,
            error: '',
          })
        } catch (error) {
          setState((current) => ({ ...current, loading: false, error: errorMessage(error) }))
        }
      }

      React.useEffect(() => {
        refresh()
      }, [])

      async function remove(name) {
        if (!globalThis.confirm(`确定删除“${name}”吗？此操作不可恢复。`)) return
        setDeleting(name)
        try {
          const response = await fetch(`${API_PATH}?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
          await responseJson(response)
          await refresh()
        } catch (error) {
          setState((current) => ({ ...current, error: errorMessage(error) }))
        } finally {
          setDeleting('')
        }
      }

      async function previewFile(name) {
        setPreviewMaximized(false)
        try {
          const isOffice = /\.(docx|xlsx|pptx)$/i.test(name)
          if (isOffice) {
            const response = await fetch(previewUrl(name), { cache: 'no-store' })
            if (!response.ok) {
              const body = await response.json().catch(() => ({}))
              throw new Error(body.error || `HTTP ${response.status}`)
            }
            const data = await response.json().catch(() => ({}))
            setPreview({
              name,
              officeHtml: data.officeHtml ?? '<p style="font-family:sans-serif;padding:12px">（无法渲染此文档）</p>',
            })
            return
          }
          const response = await fetch(previewUrl(name), { cache: 'no-store' })
          if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            throw new Error(body.error || `HTTP ${response.status}`)
          }
          const type = response.headers.get('content-type') || ''
          if (type.startsWith('image/')) {
            const blob = await response.blob()
            const url = URL.createObjectURL(blob)
            setPreview({ url, name })
            return
          }
          window.open(previewUrl(name), '_blank', 'noopener')
        } catch (error) {
          setState((current) => ({ ...current, error: errorMessage(error) }))
        }
      }

      function closePreview() {
        if (preview?.url) URL.revokeObjectURL(preview.url)
        setPreview(null)
      }

      return React.createElement(
        'section',
        { className: 'dsh-upload-settings' },
        React.createElement(
          'div',
          { className: 'dsh-upload-settings-head' },
          React.createElement(
            'div',
            null,
            React.createElement('h2', null, '上传文件'),
            React.createElement('p', null, '管理从输入框上传到 Harness 容器中的文件。'),
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'dsh-upload-refresh', disabled: state.loading, onClick: refresh },
            state.loading ? '刷新中…' : '刷新',
          ),
        ),
        React.createElement(
          'div',
          { className: 'dsh-upload-root' },
          React.createElement('span', null, '固定目录'),
          React.createElement('code', null, state.root || '读取中…'),
          state.maxFileBytes
            ? React.createElement('small', null, `单文件上限 ${sizeText(state.maxFileBytes)}`)
            : null,
          state.totalMaxBytes
            ? React.createElement('small', null, `已使用 ${sizeText(state.usedBytes)} / ${sizeText(state.totalMaxBytes)}`)
            : null,
        ),
        state.error ? React.createElement('div', { className: 'dsh-upload-error' }, state.error) : null,
        !state.loading && state.files.length === 0
          ? React.createElement('div', { className: 'dsh-upload-empty' }, '当前没有已上传文件。')
          : null,
        preview
          ? React.createElement(
              'div',
              { className: 'dsh-upload-preview-overlay' + (previewMaximized ? ' dsh-upload-preview-overlay-max' : ''), onClick: closePreview },
              React.createElement(
                'div',
                { className: 'dsh-upload-preview-card' + (previewMaximized ? ' dsh-upload-preview-card-max' : ''), onClick: (event) => event.stopPropagation() },
                React.createElement(
                  'div',
                  { className: 'dsh-upload-preview-head' },
                  React.createElement('strong', null, preview.name),
                  React.createElement('button', { type: 'button', onClick: () => setPreviewMaximized((m) => !m) }, previewMaximized ? '还原窗口' : '放大窗口'),
                  React.createElement('button', { type: 'button', onClick: closePreview }, '关闭'),
                ),
                preview.url
                  ? React.createElement('img', { src: preview.url, alt: preview.name, className: 'dsh-upload-preview-img' })
                  : React.createElement('iframe', { title: preview.name, srcDoc: preview.officeHtml ?? '', style: previewMaximized ? { width: '100%', height: 'calc(100vh - 60px)', border: 'none', background: '#fff', flex: 1 } : { width: '100%', height: '70vh', border: 'none', background: '#fff' }, sandbox: 'allow-same-origin' }),
              ),
            )
          : null,
        React.createElement(
          'div',
          { className: 'dsh-upload-list' },
          state.files.map((file) => React.createElement(
            'div',
            { className: 'dsh-upload-row', key: file.name },
            React.createElement('span', { className: 'dsh-upload-file-name', title: file.path }, file.name),
            React.createElement('span', { className: 'dsh-upload-file-meta' }, `${sizeText(file.size)} · ${dateText(file.modifiedAt)}`),
            React.createElement(
              'div',
              { className: 'dsh-upload-actions' },
              React.createElement('button', { type: 'button', className: 'dsh-upload-preview', onClick: () => previewFile(file.name) }, '预览'),
              React.createElement('a', { href: downloadUrl(file.name), download: file.name }, '下载'),
              React.createElement(
                'button',
                { type: 'button', disabled: deleting === file.name, onClick: () => remove(file.name) },
                deleting === file.name ? '删除中…' : '删除',
              ),
            ),
          )),
        ),
      )
    }

    const CSS = `
      [data-decoration="chip"][title^="${HIDDEN_LABEL}"]{display:inline-block!important;width:0!important;height:0!important;overflow:hidden!important;background:transparent!important;border:none!important;box-shadow:none!important;margin:0!important;padding:0!important;font-size:0!important;line-height:0!important}
      [data-decoration="chip"][title^="${HIDDEN_LABEL}"]:before,[data-decoration="chip"][title^="${HIDDEN_LABEL}"]>*{display:none!important}
      .dsh-upload-control{display:flex;align-items:center;min-width:0}
      .dsh-upload-picker,.dsh-upload-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
      .dsh-upload-button{height:28px;width:28px;padding:0;border:0;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .dsh-upload-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dsh-upload-button:disabled{opacity:.55;cursor:wait}
      .dsh-upload-icon{width:18px;height:18px;display:block}
      .dsh-upload-rail{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width);margin:0 auto 6px;padding:0 var(--dsh-composer-side-clearance);display:flex;gap:8px;overflow-x:auto;scrollbar-width:none}
      .dsh-upload-rail::-webkit-scrollbar{display:none}
      .dsh-upload-chip{min-width:180px;max-width:260px;height:54px;box-sizing:border-box;display:flex;align-items:center;gap:9px;padding:8px 8px 8px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv1);color:var(--dsw-alias-label-primary)}
      .dsh-upload-chip-icon{width:28px;height:28px;display:grid;place-items:center;flex:none;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:16px}
      .dsh-upload-chip-copy{display:flex;flex-direction:column;min-width:0;flex:1}
      .dsh-upload-chip-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
      .dsh-upload-chip-copy small{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px}
      .dsh-upload-chip>button{width:24px;height:24px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:20px;cursor:pointer;flex:none}
      .dsh-upload-chip>button:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
      .dsh-upload-settings{display:flex;flex-direction:column;gap:16px;min-width:0;padding:4px 2px 24px;color:var(--dsw-alias-label-primary)}
      .dsh-upload-settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .dsh-upload-settings h2{margin:0;font-size:20px;line-height:28px}
      .dsh-upload-settings p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      .dsh-upload-refresh,.dsh-upload-actions button,.dsh-upload-actions a{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:6px 11px;font:inherit;font-size:12px;line-height:18px;text-decoration:none;cursor:pointer}
      .dsh-upload-refresh:hover:not(:disabled),.dsh-upload-actions button:hover:not(:disabled),.dsh-upload-actions a:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-upload-root{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 12px;align-items:center;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-input-major)}
      .dsh-upload-root span{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .dsh-upload-root code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
      .dsh-upload-root small{grid-column:2;color:var(--dsw-alias-label-secondary)}
      .dsh-upload-error{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}
      .dsh-upload-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
      .dsh-upload-list{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l2)}
      .dsh-upload-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:13px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform,transparent);margin-bottom:4px}
      .dsh-upload-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
      .dsh-upload-file-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .dsh-upload-actions{display:flex;flex:none;gap:7px}
      .dsh-upload-actions button{color:var(--dsw-alias-state-error-primary)}
      @media (max-width:640px){.dsh-upload-row{align-items:stretch;flex-direction:column;gap:4px}.dsh-upload-file-name{white-space:normal;word-break:break-all}.dsh-upload-actions{width:100%}.dsh-upload-actions a,.dsh-upload-actions button{flex:1;text-align:center}.dsh-upload-chip{min-width:160px}}
      .dsh-ws-folder:hover{background:var(--dsw-alias-interactive-bg-hover)}
      @media (max-width: 767px){
        .dsh-ws-row{flex-direction:column!important;align-items:stretch!important;gap:4px!important}
        .dsh-ws-name{white-space:normal!important;word-break:break-all}
        .dsh-ws-meta{font-size:11px}
        .dsh-ws-actions{width:100%;display:flex!important;gap:6px}
        .dsh-ws-actions button,.dsh-ws-actions a{flex:1;text-align:center;padding:5px 4px}
      }
      .dsh-upload-actions button.dsh-upload-preview{color:var(--dsw-alias-label-primary)}
      .dsh-upload-preview-overlay{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}
      .dsh-upload-preview-overlay-max{padding:0}
      .dsh-upload-preview-card{box-sizing:border-box;background:var(--dsw-specific-input-major);border-radius:14px;max-width:min(560px,100%);max-height:90%;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--dsw-shadow-lv3)}
      .dsh-upload-preview-card-max{width:100%;height:100%;max-width:none;max-height:none;border-radius:0}
      .dsh-upload-preview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}
      .dsh-upload-preview-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
      .dsh-upload-preview-head button{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}
      .dsh-upload-preview-img{max-width:100%;max-height:70vh;object-fit:contain;display:block}
    `

    const inject = ['slots', 'sessions', 'inputTriggers', 'conversation', 'timer']

        function WorkspaceFilesSection() {
      const [groups, setGroups] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState({})
      const [copied, setCopied] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [edited, setEdited] = React.useState('')
      const [savedFlash, setSavedFlash] = React.useState(false)
      const [maximized, setMaximized] = React.useState(false)
      const toggleFolder = (folder) => setCollapsed((prev) => ({ ...prev, [folder]: !prev[folder] }))

      const load = React.useCallback(async () => {
        try {
          const res = await fetch('/api/dsh-uploads/workspace', { headers: { Accept: 'application/json' } })
          if (!res.ok) { setError(`HTTP ${res.status}`); return }
          const data = await res.json()
          if (data.ok === true) { setGroups(data.groups); setError(null) }
          else setError(data.error)
        } catch (e) { setError(String((e && e.message) || e)) }
      }, [])
      React.useEffect(() => { load() }, [load])

      const openPreview = async (path) => {
        setPreview({ path, loading: true })
        try {
          const res = await fetch('/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(path), { headers: { Accept: 'application/json' } })
          const data = await res.json()
          setPreview(data.ok === true ? data : { path, error: data.error })
        } catch (e) { setPreview({ path, error: String((e && e.message) || e) }) }
      }
      const doDelete = async (path) => {
        if (!window.confirm(`确认删除该文件？\n${path}`)) return
        setBusy(true)
        try {
          const res = await fetch('/api/dsh-uploads/workspace-file/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path }),
          })
          const data = await res.json().catch(() => ({}))
          if (data.ok === true) {
            if (preview !== null && preview.path === path) setPreview(null)
            load()
          } else setError(data.error || `HTTP ${res.status}`)
        } catch (e) { setError(String((e && e.message) || e)) }
        setBusy(false)
      }
      const copyContent = async () => {
        if (preview === null) return
        const text = preview.content !== void 0 ? preview.content : preview.officeHtml !== void 0 ? preview.officeHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : void 0
        if (text === void 0) return
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch (e) {
          try {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          } catch (err) {
            setError(String((err && err.message) || err))
          }
        }
      }

            const doSave = async () => {
        if (preview === null) return
        setBusy(true)
        try {
          const res = await fetch('/api/dsh-uploads/workspace-file/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: preview.path, content: edited }),
          })
          const data = await res.json().catch(() => ({}))
          if (data.ok === true) {
            setPreview((prev) => prev === null ? prev : { ...prev, content: edited, truncated: false })
            setEditing(false)
            setSavedFlash(true)
            setTimeout(() => setSavedFlash(false), 1500)
          } else setError(data.error || `HTTP ${res.status}`)
        } catch (e) { setError(String((e && e.message) || e)) }
        setBusy(false)
      }

      const rowStyle = {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-module-platform, transparent)', fontSize: 13,
      }
      const nameStyle = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)' }
      const metaStyle = { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }
      const btnStyle = { flex: 'none', cursor: 'pointer', border: 'none', borderRadius: 6, padding: '3px 8px', fontSize: 12, background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' }
      const delStyle = { ...btnStyle, color: 'var(--dsw-alias-state-error-primary)' }
      const folderBtnStyle = {
        display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', border: 'none', background: 'transparent',
        padding: '6px 2px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
        textAlign: 'left', borderRadius: 6, fontFamily: 'inherit',
      }
      const preStyle = {
        margin: 0, padding: 12, borderRadius: 0, border: 'none', flex: 1, minHeight: 0, overflow: 'auto',
        fontFamily: 'var(--dsw-font-family-mono, monospace)', fontSize: 12, lineHeight: '16px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)',
      }
      const textareaStyle = {
        margin: 0, padding: 12, border: 'none', flex: 1, minHeight: 0, resize: 'none', outline: 'none',
        fontFamily: 'var(--dsw-font-family-mono, monospace)', fontSize: 12, lineHeight: '16px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-module-platform, transparent)',
      }
      const overlayStyle = {
        position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(0,0,0,.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: maximized ? 0 : 16,
      }
      const previewCardStyle = maximized
        ? { boxSizing: 'border-box', background: 'var(--dsw-specific-input-major)', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
        : {
          boxSizing: 'border-box', background: 'var(--dsw-specific-input-major)', borderRadius: 14,
          maxWidth: 'min(560px, 100%)', width: '100%', height: 'min(70vh, 640px)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--dsw-shadow-lv3)',
        }
      const previewHeadStyle = {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: 'none',
      }

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '工作区输出文件（按文件夹分类，预览 / 下载 / 删除）'),
        error !== null && React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error),
        groups === null && error === null && React.createElement('div', { style: metaStyle }, '加载中…'),
        groups !== null && groups.length === 0 && React.createElement('div', { style: metaStyle }, '目录为空'),
        groups !== null && groups.map((group) => React.createElement(
          'div',
          { key: group.folder, style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-ws-folder',
              style: folderBtnStyle,
              'aria-expanded': !collapsed[group.folder],
              onClick: () => toggleFolder(group.folder),
            },
            `${collapsed[group.folder] ? '▸' : '▾'} ${group.folder} (${group.files.length})`,
          ),
          !collapsed[group.folder] && group.files.map((f) => React.createElement(
            'div',
            { key: f.path, className: 'dsh-ws-row', style: rowStyle },
            React.createElement('span', { className: 'dsh-ws-name', style: nameStyle, title: f.path }, f.path),
            React.createElement('span', { className: 'dsh-ws-meta', style: metaStyle }, `${sizeText(f.size)} · ${dateText(f.mtime)}`),
            React.createElement(
              'div',
              { className: 'dsh-ws-actions', style: { display: 'flex', gap: 6, flex: 'none' } },
              React.createElement('button', { type: 'button', style: btnStyle, disabled: busy, onClick: () => openPreview(f.path) }, '预览'),
              React.createElement('a', { href: '/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(f.path) + '&download=1', download: f.name, style: btnStyle }, '下载'),
              React.createElement('button', { type: 'button', style: delStyle, disabled: busy, onClick: () => doDelete(f.path) }, '删除'),
            ),
          )),
        )),
        preview !== null && React.createElement(
          'div',
          { className: 'dsh-ws-preview-overlay', style: overlayStyle, onClick: () => setPreview(null) },
          React.createElement(
            'div',
            { className: 'dsh-ws-preview-card', style: previewCardStyle, onClick: (e) => e.stopPropagation() },
            React.createElement(
              'div',
              { style: previewHeadStyle },
              React.createElement('strong', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 } }, `${preview.name ?? preview.path}`),
              preview.binary !== true && React.createElement('button', { type: 'button', style: btnStyle, disabled: busy, onClick: () => { if (editing) { setEdited(preview.content !== void 0 ? preview.content : ''); setEditing(false); } else setEditing(true); } }, editing ? '取消编辑' : '编辑'),
              editing && React.createElement('button', { type: 'button', style: btnStyle, disabled: busy, onClick: doSave }, savedFlash ? '已保存' : '保存'),
              React.createElement('button', { type: 'button', style: btnStyle, onClick: copyContent }, copied ? '已复制' : '复制全部'),
              React.createElement('button', { type: 'button', style: btnStyle, onClick: () => setMaximized((m) => !m) }, maximized ? '还原窗口' : '放大窗口'),
              React.createElement('button', { type: 'button', style: btnStyle, onClick: () => setPreview(null) }, '关闭'),
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' } },
              preview.loading === true && React.createElement('div', { style: { ...metaStyle, padding: 10 } }, '加载中…'),
              preview.error !== void 0 && preview.loading !== true && React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', padding: 10 } }, preview.error),
              preview.binary === true && preview.officeHtml === void 0 && React.createElement('div', { style: { ...metaStyle, padding: 10 } }, '二进制文件，无法预览，请下载后查看'),
              preview.officeHtml !== void 0 && React.createElement('iframe', { title: preview.name ?? preview.path, srcDoc: preview.officeHtml, style: { width: '100%', flex: 1, minHeight: 0, border: 'none', background: '#fff' }, sandbox: 'allow-same-origin' }),
              editing && preview.binary !== true && React.createElement('textarea', { style: textareaStyle, value: edited, onChange: (e) => setEdited(e.target.value), spellCheck: false }),
              !editing && preview.binary !== true && preview.content !== void 0 && React.createElement('pre', { style: preStyle }, preview.content),
              preview.truncated === true && React.createElement('div', { style: { ...metaStyle, padding: '4px 12px 10px' } }, '（内容过大，仅显示前 256KB）'),
            ),
          ),
        ),
      )
    }

    function apply(ctx) {
      const controller = new FileDraftController(ctx)
      ctx.effect(() => () => controller.dispose(), 'dsh-upload-manager: draft-file state')
      ctx.effect(() => ctx.inputTriggers.registerSource({
        trigger: '@',
        name: SOURCE,
        order: 10_000,
        candidates: async () => [],
        onPick: () => undefined,
        codec: {
          clipboardText: () => '',
          serialize: async (ref) => {
            const file = controller.fileForRef(ref)
            if (!file) throw new Error('待发送文件已失效，请重新上传')
            controller.markSerializing(ref)
            return serializedFile(file)
          },
        },
      }), 'dsh-upload-manager: hidden file reference codec')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-file-uploads'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-upload-manager: styles')

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'local-file-upload',
        order: -20,
        label: '上传文件',
      }, (props) => React.createElement(UploadControl, { ...props, controller })))

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'local-file-upload-rail',
        order: 80,
        label: '待发送文件',
      }, (props) => React.createElement(PendingFileRail, { ...props, controller })))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'uploaded-files',
        order: 30,
        label: '上传文件',
      }, UploadSettingsSection))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'output-files',
        order: 35,
        label: '输出文件',
      }, WorkspaceFilesSection))
    }
      return { apply, inject }
    })()

    // ===== dsh-skill-docs: 技能文档 section =====
    const skillDocsPlugin = (() => {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/** `skillDocs` namespace dictionaries. */
		const zh = {
			"nav": "技能文档",
			"files.hint": "技能文档目录（可折叠，点击预览可编辑）",
			"files.loading": "加载中…",
			"files.empty": "目录为空",
			"files.preview": "预览",
			"files.download": "下载",
			"files.binary": "二进制文件，无法编辑，请下载后查看",
			"files.truncated": "（内容过大，仅显示/编辑前 256KB）",
			"files.close": "关闭",
			"files.edit": "编辑",
			"files.cancelEdit": "取消编辑",
			"files.save": "保存",
			"files.saved": "已保存",
			"files.copy": "复制全部",
			"files.copied": "已复制",
			"files.maximize": "放大窗口",
			"files.restore": "还原窗口"
		};
		const en = {
			"nav": "Skill docs",
			"files.hint": "Skill docs (collapsible; preview opens an editor)",
			"files.loading": "Loading…",
			"files.empty": "Directory is empty",
			"files.preview": "Preview",
			"files.download": "Download",
			"files.binary": "Binary file — download to view",
			"files.truncated": "(Large file — showing/editing first 256KB)",
			"files.close": "Close",
			"files.edit": "Edit",
			"files.cancelEdit": "Cancel edit",
			"files.save": "Save",
			"files.saved": "Saved",
			"files.copy": "Copy all",
			"files.copied": "Copied",
			"files.maximize": "Maximize",
			"files.restore": "Restore"
		};
		function SkillsSection({ t }) {
			const [groups, setGroups] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [preview, setPreview] = react.useState(null);
			const [collapsed, setCollapsed] = react.useState({});
			const [maximized, setMaximized] = react.useState(false);
			const [editing, setEditing] = react.useState(false);
			const [edited, setEdited] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [savedFlash, setSavedFlash] = react.useState(false);
			const [copiedFlash, setCopiedFlash] = react.useState(false);
			const toggleFolder = (folder) => setCollapsed((prev) => ({ ...prev, [folder]: !prev[folder] }));

			const load = react.useCallback(async () => {
				try {
					const res = await fetch("/dsh-skill-docs/skill-docs", { headers: { Accept: "application/json" } });
					if (!res.ok) { setError(`HTTP ${res.status}`); return; }
					const data = await res.json();
					if (data.ok === true) { setGroups(data.groups); setError(null); }
					else setError(data.error);
				}
				catch (e) { setError(String((e && e.message) || e)); }
			}, []);
			react.useEffect(() => { load(); }, [load]);

			const openDoc = async (path) => {
				setPreview({ path, loading: true });
				setEditing(false);
				setMaximized(false);
				try {
					const res = await fetch("/dsh-skill-docs/skill-doc?path=" + encodeURIComponent(path), { headers: { Accept: "application/json" } });
					const data = await res.json();
					if (data.ok === true) {
						setPreview(data);
						setEdited(data.content !== void 0 ? data.content : "");
					}
					else setPreview({ path, error: data.error });
				}
				catch (e) { setPreview({ path, error: String((e && e.message) || e) }); }
			};

			const doSave = async () => {
				if (preview === null) return;
				setBusy(true);
				try {
					const res = await fetch("/dsh-skill-docs/skill-doc/save", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ path: preview.path, content: edited })
					});
					const data = await res.json().catch(() => ({}));
					if (data.ok === true) {
						setPreview((prev) => prev === null ? prev : { ...prev, content: edited, truncated: false });
						setEditing(false);
						setSavedFlash(true);
						setTimeout(() => setSavedFlash(false), 1500);
					}
					else setError(data.error || `HTTP ${res.status}`);
				}
				catch (e) { setError(String((e && e.message) || e)); }
				setBusy(false);
			};

			const copyAll = async () => {
				if (preview === null || edited === "") return;
				try {
					await navigator.clipboard.writeText(edited);
					setCopiedFlash(true);
					setTimeout(() => setCopiedFlash(false), 1500);
				}
				catch (e) {
					try {
						const ta = document.createElement("textarea");
						ta.value = edited;
						ta.style.position = "fixed";
						ta.style.opacity = "0";
						document.body.appendChild(ta);
						ta.select();
						document.execCommand("copy");
						document.body.removeChild(ta);
						setCopiedFlash(true);
						setTimeout(() => setCopiedFlash(false), 1500);
					}
					catch (err) { setError(String((err && err.message) || err)); }
				}
			};

			const rowStyle = {
				display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-module-platform, transparent)", fontSize: 13
			};
			const nameStyle = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary)" };
			const metaStyle = { flex: "none", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 };
			const btnStyle = {
				flex: "none", cursor: "pointer", border: "none", borderRadius: 6, padding: "3px 8px", fontSize: 12,
				background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-secondary)"
			};
			const folderBtnStyle = {
				display: "flex", alignItems: "center", gap: 6, cursor: "pointer", border: "none", background: "transparent",
				padding: "6px 2px", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)",
				textAlign: "left", borderRadius: 6, fontFamily: "inherit"
			};
			const preStyle = {
				margin: 0, padding: 12, borderRadius: 0, border: "none", flex: 1, minHeight: 0, overflow: "auto",
				fontFamily: "var(--dsw-font-family-mono, monospace)", fontSize: 12, lineHeight: "16px",
				whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsw-alias-label-primary)"
			};
			const textareaStyle = {
				margin: 0, padding: 12, border: "none", flex: 1, minHeight: 0, resize: "none", outline: "none",
				fontFamily: "var(--dsw-font-family-mono, monospace)", fontSize: 12, lineHeight: "16px",
				whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-module-platform, transparent)"
			};
			const overlayStyle = {
				position: "fixed", inset: 0, zIndex: 1300, background: "rgba(0,0,0,.55)",
				display: "flex", alignItems: "center", justifyContent: "center", padding: maximized ? 0 : 16
			};
			const cardStyle = maximized
				? { boxSizing: "border-box", background: "var(--dsw-specific-input-major)", width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }
				: {
					boxSizing: "border-box", background: "var(--dsw-specific-input-major)", borderRadius: 14,
					maxWidth: "min(560px, 100%)", width: "100%", height: "min(70vh, 640px)",
					display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "var(--dsw-shadow-lv3)"
				};
			const headStyle = {
				display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
				padding: "8px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)", flex: "none", flexWrap: "wrap"
			};

			return react_jsx_runtime.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
				children: [
					react_jsx_runtime.jsx("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }, children: t("files.hint") }),
					error !== null && react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }, children: error }),
					groups === null && error === null && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.loading") }),
					groups !== null && groups.length === 0 && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.empty") }),
					groups !== null && groups.map((group) => react_jsx_runtime.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: folderBtnStyle,
								"aria-expanded": !collapsed[group.folder],
								onClick: () => toggleFolder(group.folder),
								children: `${collapsed[group.folder] ? "▸" : "▾"} ${group.folder} (${group.files.length})`
							}),
							!collapsed[group.folder] && group.files.map((f) => react_jsx_runtime.jsxs("div", {
								style: rowStyle,
								children: [
									react_jsx_runtime.jsx("span", { style: nameStyle, title: f.path, children: f.path }),
									react_jsx_runtime.jsx("span", { style: metaStyle, children: `${f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KiB`}` }),
									react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, onClick: () => openDoc(f.path), children: t("files.preview") }),
									react_jsx_runtime.jsx("a", { href: "/dsh-skill-docs/skill-doc?path=" + encodeURIComponent(f.path) + "&download=1", download: f.name, style: btnStyle, children: t("files.download") })
								]
							}, f.path))
						]
					}, group.folder)),
					preview !== null && react_jsx_runtime.jsxs("div", {
						style: overlayStyle,
						onClick: () => setPreview(null),
						children: [
							react_jsx_runtime.jsxs("div", {
								style: cardStyle,
								onClick: (e) => e.stopPropagation(),
								children: [
									react_jsx_runtime.jsxs("div", {
										style: headStyle,
										children: [
											react_jsx_runtime.jsx("strong", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }, children: `${preview.name ?? preview.path}` }),
											preview.binary !== true && react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, disabled: busy, onClick: () => { if (editing) { setEdited(preview.content !== void 0 ? preview.content : ""); setEditing(false); } else setEditing(true); }, children: editing ? t("files.cancelEdit") : t("files.edit") }),
											editing && react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, disabled: busy, onClick: doSave, children: savedFlash ? t("files.saved") : t("files.save") }),
											react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, onClick: copyAll, children: copiedFlash ? t("files.copied") : t("files.copy") }),
											react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, onClick: () => setMaximized((m) => !m), children: maximized ? t("files.restore") : t("files.maximize") }),
											react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, onClick: () => setPreview(null), children: t("files.close") })
										]
									}),
									react_jsx_runtime.jsxs("div", {
										style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "auto" },
										children: [
											preview.loading === true && react_jsx_runtime.jsx("div", { style: { ...metaStyle, padding: 10 }, children: t("files.loading") }),
											preview.error !== void 0 && preview.loading !== true && react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)", padding: 10 }, children: preview.error }),
											preview.binary === true && react_jsx_runtime.jsx("div", { style: { ...metaStyle, padding: 10 }, children: t("files.binary") }),
											editing && preview.binary !== true && react_jsx_runtime.jsx("textarea", { style: textareaStyle, value: edited, onChange: (e) => setEdited(e.target.value), spellCheck: false }),
											!editing && preview.content !== void 0 && react_jsx_runtime.jsx("pre", { style: preStyle, children: preview.content }),
											preview.truncated === true && react_jsx_runtime.jsx("div", { style: { ...metaStyle, padding: "4px 12px 10px" }, children: t("files.truncated") })
										]
									})
								]
							})
						]
					})
				]
			});
		}
		/** Dictionary namespace owned by this plugin. */
		const NS = "skillDocs";
		/** Services required by this client plugin. */
		const inject = ["slots", "locale"];
		/** Register the skill-docs settings section. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-skill-docs: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skill-docs",
				order: 15,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({})
			}, SkillsSection));
		}
      return { apply, inject }
    })()

    // ===== dsh-token-usage: balance chip + mobile CSS =====
    const tokenUsagePlugin = (() => {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/** Mobile CSS overrides for the dsh web shell (composer action row,
		 * settings panel layout, theme picker) — see MOBILE_CSS. */
				const MOBILE_CSS = "@media (max-width: 767px){.uV2eYG_row{gap:4px;padding:2px 4px 6px}.uV2eYG_tools{gap:8px}.uV2eYG_modes{gap:4px;min-width:0}.uV2eYG_trailing{gap:4px}.Sh0Q9G_trigger{max-width:104px;padding:0 2px 0 6px;font-size:12px}._7KE1Ra_trigger{max-width:56px;gap:2px;padding:0 2px 0 4px}._7KE1Ra_triggerLabel{display:none}._7KE1Ra_triggerEffort{display:none}._7KE1Ra_trigger::before{content:'';flex:none;width:16px;height:12px;color:var(--dsw-alias-label-secondary);background:url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2023.16%2017.04%22%3E%3Cpath%20fill%3D%22currentColor%22%20d%3D%22M22.9168%201.43018C22.6713%201.31018%2022.5658%201.53918%2022.4223%201.65519C22.3733%201.69269%2022.3318%201.74169%2022.2903%201.78669C21.9317%202.1697%2021.5127%202.42121%2020.9657%202.39121C20.1657%202.34621%2019.4827%202.59771%2018.8787%203.20973C18.7502%202.45521%2018.3236%202.0047%2017.6746%201.71569C17.3351%201.56568%2016.9916%201.41518%2016.7536%201.08867C16.5876%200.856163%2016.5421%200.597155%2016.4591%200.341647C16.4061%200.187643%2016.3536%200.0301382%2016.1761%200.00363739C15.9836%20-0.0263635%2015.9081%200.135141%2015.8326%200.270145C15.5306%200.822162%2015.4136%201.43018%2015.4251%202.0462C15.4516%203.43174%2016.0366%204.53527%2017.1991%205.3203C17.3311%205.4103%2017.3651%205.5003%2017.3236%205.63181C17.2441%205.90231%2017.1501%206.16482%2017.0671%206.43533C17.0141%206.60784%2016.9351%206.64584%2016.7501%206.57033C16.1121%206.30383%2015.5611%205.90931%2015.074%205.4328C14.2475%204.63328%2013.5%203.75075%2012.568%203.05973C12.349%202.89822%2012.13%202.74822%2011.9034%202.60522C10.9524%201.68169%2012.028%200.923165%2012.277%200.833162C12.5375%200.739159%2012.3675%200.41615%2011.5259%200.42015C10.6844%200.42365%209.91439%200.705658%208.93286%201.08117C8.78935%201.13767%208.63835%201.17867%208.48384%201.21267C7.59332%201.04367%206.66829%201.00617%205.70226%201.11517C3.88321%201.31768%202.43016%202.1777%201.36213%203.64575C0.0790928%205.4103%20-0.222916%207.41536%200.146595%209.50642C0.535106%2011.7105%201.66014%2013.535%203.38869%2014.9616C5.18125%2016.4406%207.24581%2017.1657%209.60138%2017.0266C11.0319%2016.9441%2012.6245%2016.7526%2014.421%2015.2321C14.874%2015.4576%2015.3496%2015.5476%2016.1381%2015.6151C16.7456%2015.6716%2017.3306%2015.5851%2017.7836%2015.4911C18.4931%2015.3411%2018.4441%2014.6841%2018.1876%2014.5636C16.1081%2013.595%2016.5646%2013.9891%2016.1496%2013.67C17.2061%2012.42%2018.8202%2010.1979%2019.3182%207.17235C19.3672%206.83834%2019.4297%206.36783%2019.4222%206.09732C19.4182%205.93231%2019.4562%205.86831%2019.6447%205.84931C20.1657%205.78931%2020.6712%205.64681%2021.1357%205.3913C22.4833%204.65528%2023.0268%203.44624%2023.1548%201.9972C23.1738%201.77569%2023.1508%201.54668%2022.9168%201.43018ZM11.1749%2014.4736C9.15936%2012.889%208.18184%2012.3675%207.77832%2012.39C7.40081%2012.4125%207.46881%2012.8445%207.55182%2013.126C7.63882%2013.404%207.75182%2013.5955%207.91033%2013.8396C8.01983%2014.0011%208.09533%2014.2411%207.80083%2014.4216C7.15181%2014.8231%206.02327%2014.2866%205.97027%2014.2601C4.65673%2013.4865%203.5587%2012.4655%202.78467%2011.069C2.03715%209.72493%201.60314%208.28289%201.53164%206.74384C1.51264%206.37233%201.62214%206.24082%201.99215%206.17332C2.47916%206.08332%202.98118%206.06432%203.46769%206.13582C5.52476%206.43633%207.27581%207.35586%208.74385%208.8129C9.58188%209.64243%2010.2159%2010.634%2010.8689%2011.6025C11.5634%2012.631%2012.3105%2013.611%2013.262%2014.4146C13.598%2014.6961%2013.866%2014.9101%2014.1225%2015.0681C13.349%2015.1546%2012.058%2015.1731%2011.1749%2014.4746L11.1749%2014.4736ZM12.141%208.25988C12.141%208.09488%2012.273%207.96338%2012.439%207.96338C12.4765%207.96338%2012.5105%207.97088%2012.541%207.98188C12.5825%207.99688%2012.6205%208.01938%2012.6505%208.05338C12.7035%208.10588%2012.7335%208.18088%2012.7335%208.25988C12.7335%208.42489%2012.6015%208.55639%2012.4355%208.55639C12.2695%208.55639%2012.141%208.42489%2012.141%208.25988ZM15.1415%209.79893C14.949%209.87793%2014.7565%209.94544%2014.5715%209.95294C14.2845%209.96794%2013.9715%209.85143%2013.8015%209.70893C13.5375%209.48742%2013.3485%209.36342%2013.2695%208.97691C13.2355%208.8119%2013.2545%208.55639%2013.2845%208.40989C13.3525%208.09438%2013.277%207.89187%2013.0545%207.70787C12.8735%207.55786%2012.643%207.51636%2012.39%207.51636C12.2955%207.51636%2012.209%207.47486%2012.1445%207.44136C12.039%207.38886%2011.9519%207.25735%2012.035%207.09585C12.0615%207.04335%2012.19%206.91584%2012.22%206.89334C12.5635%206.69784%2012.9595%206.76184%2013.326%206.90834C13.6655%207.04735%2013.9225%207.30236%2014.292%207.66287C14.6695%208.09838%2014.7375%208.21838%2014.9525%208.54539C15.1225%208.8009%2015.277%209.06341%2015.3831%209.36392C15.4471%209.55142%2015.3641%209.70493%2015.1415%209.79893Z%22/%3E%3C/svg%3E') no-repeat center/contain}.VOzbGW_panel{width:100%;max-width:calc(100vw - 24px);height:min(800px,calc(100vh - 24px));height:min(800px,calc(100svh - 24px));border-radius:20px;flex-direction:column}.VOzbGW_nav{flex-direction:row;align-items:center;width:100%;gap:8px;padding:10px 10px 0}.VOzbGW_navTitle{display:none}.VOzbGW_navList{flex-direction:row;gap:4px;flex:1;min-width:0;overflow-x:auto;padding-bottom:4px}.VOzbGW_navCell{height:36px;padding:6px 12px;white-space:nowrap}.VOzbGW_navLabel{white-space:nowrap}.VOzbGW_content{min-height:0}.VOzbGW_options{padding:0 12px 16px}._8HJdBW_cubeRow{gap:6px}._8HJdBW_themeCube{flex:1 1 calc(33.333% - 4px);padding:10px 2px;gap:2px;border-radius:12px;font-size:11px;line-height:15px}._8HJdBW_themeCube svg{width:18px;height:18px}}";
		function injectMobileCss() {
			const tagId = "dsh-token-usage/mobile";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-token-usage";
				tag.dataset.pluginCss = tagId;
				tag.textContent = MOBILE_CSS;
				document.head.appendChild(tag);
			}
		}
		/** Format bytes as B / KB / MB. */
		function formatBytes(n) {
			if (n < 1024) return `${n} B`;
			if (n < 1048576) return `${Math.round(n / 1024)} KB`;
			return `${Math.round(n / 1048576 * 10) / 10} MB`;
		}
		/** Short local date/time for a mtime epoch (ms). */
		function formatDate(ms) {
			const d = new Date(ms);
			const pad = (v) => String(v).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}
		/** `tokenUsage` namespace dictionaries (settings file panel copy). */
		const zh = {
			"nav": "输出文件",
			"files.hint": "工作区输出文件（按文件夹分类，预览 / 下载 / 删除）",
			"files.loading": "加载中…",
			"files.empty": "目录为空",
			"files.preview": "预览",
			"files.download": "下载",
			"files.delete": "删除",
			"files.confirmDelete": "确认删除该文件？",
			"files.binary": "二进制文件，无法预览，请下载后查看",
			"files.truncated": "（内容过大，仅显示前 256KB）",
			"files.close": "关闭预览",
			"skills.hint": "技能文档（各技能的 SKILL.md），可预览",
			"balance": "余额"
		};
		const en = {
			"nav": "Output files",
			"files.hint": "Workspace output files (grouped by folder; preview / download / delete)",
			"files.loading": "Loading…",
			"files.empty": "Directory is empty",
			"files.preview": "Preview",
			"files.download": "Download",
			"files.delete": "Delete",
			"files.confirmDelete": "Delete this file?",
			"files.binary": "Binary file — download to view",
			"files.truncated": "(Large file — showing first 256KB)",
			"files.close": "Close preview",
			"skills.hint": "Skill documents (per-skill SKILL.md), previewable",
			"balance": "Balance"
		};
		/** Settings section: list the plugin's files with preview / download / delete. */
		function FilesSection({ t }) {
			const [groups, setGroups] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [preview, setPreview] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const load = react.useCallback(async () => {
				try {
					const res = await fetch("/dsh-token-usage/files", { headers: { Accept: "application/json" } });
					if (!res.ok) { setError(`HTTP ${res.status}`); return; }
					const data = await res.json();
					if (data.ok === true) { setGroups(data.groups); setError(null); }
					else setError(data.error);
				}
				catch (e) {
					setError(String((e && e.message) || e));
				}
			}, []);
			react.useEffect(() => { load(); }, [load]);
			const openPreview = async (path) => {
				setPreview({ path, loading: true });
				try {
					const res = await fetch("/dsh-token-usage/file?path=" + encodeURIComponent(path), { headers: { Accept: "application/json" } });
					const data = await res.json();
					setPreview(data.ok === true ? data : { path, error: data.error });
				}
				catch (e) {
					setPreview({ path, error: String((e && e.message) || e) });
				}
			};
			const doDelete = async (path) => {
				if (!window.confirm(`${t("files.confirmDelete")}\n${path}`)) return;
				setBusy(true);
				try {
					const res = await fetch("/dsh-token-usage/file/delete", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ path })
					});
					const data = await res.json().catch(() => ({}));
					if (data.ok === true) {
						if (preview !== null && preview.path === path) setPreview(null);
						load();
					}
					else setError(data.error || `HTTP ${res.status}`);
				}
				catch (e) {
					setError(String((e && e.message) || e));
				}
				setBusy(false);
			};
			const rowStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 8px",
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-module-platform, transparent)",
				fontSize: 13
			};
			const nameStyle = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary)" };
			const metaStyle = { flex: "none", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 };
			const btnStyle = {
				flex: "none",
				cursor: "pointer",
				border: "none",
				borderRadius: 6,
				padding: "3px 8px",
				fontSize: 12,
				background: "var(--dsw-alias-interactive-bg-hover)",
				color: "var(--dsw-alias-label-secondary)"
			};
			const delStyle = { ...btnStyle, color: "var(--dsw-alias-state-error-primary)" };
			const preStyle = {
				margin: "8px 0 0",
				padding: 10,
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-module-platform, transparent)",
				maxHeight: 320,
				overflow: "auto",
				fontFamily: "var(--dsw-font-family-mono, monospace)",
				fontSize: 12,
				lineHeight: "16px",
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
				color: "var(--dsw-alias-label-primary)"
			};
			return react_jsx_runtime.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
				children: [
					react_jsx_runtime.jsx("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }, children: t("files.hint") }),
					error !== null && react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }, children: error }),
					groups === null && error === null && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.loading") }),
					groups !== null && groups.length === 0 && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.empty") }),
					groups !== null && groups.map((group) => react_jsx_runtime.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
						children: [
							react_jsx_runtime.jsx("div", {
								style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", padding: "4px 2px 0" },
								children: `${group.folder} (${group.files.length})`
							}),
							group.files.map((f) => react_jsx_runtime.jsxs("div", {
								style: rowStyle,
								children: [
									react_jsx_runtime.jsx("span", { style: nameStyle, title: f.path, children: f.path }),
									react_jsx_runtime.jsx("span", { style: metaStyle, children: `${formatBytes(f.size)} · ${formatDate(f.mtime)}` }),
									react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, disabled: busy, onClick: () => openPreview(f.path), children: t("files.preview") }),
									react_jsx_runtime.jsx("a", { href: "/dsh-token-usage/file?path=" + encodeURIComponent(f.path) + "&download=1", download: f.name, style: btnStyle, children: t("files.download") }),
									react_jsx_runtime.jsx("button", { type: "button", style: delStyle, disabled: busy, onClick: () => doDelete(f.path), children: t("files.delete") })
								]
							}, f.path))
						]
					}, group.folder)),
					preview !== null && react_jsx_runtime.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
						children: [
							react_jsx_runtime.jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, children: `${preview.name ?? preview.path}` }),
							preview.loading === true && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.loading") }),
							preview.error !== void 0 && preview.loading !== true && react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }, children: preview.error }),
							preview.binary === true && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.binary") }),
							preview.content !== void 0 && react_jsx_runtime.jsx("pre", { style: preStyle, children: preview.content }),
							preview.truncated === true && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.truncated") }),
							react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, onClick: () => setPreview(null), children: t("files.close") })
						]
					})
				]
			});
		}
		/** Settings section: list skill documents (SKILL.md) with inline preview. */
		function useApiBalance() {
			const [balance, setBalance] = react.useState(null);
			react.useEffect(() => {
				let cancelled = false;
				const load = async () => {
					try {
						const controller = new AbortController();
						const timer = setTimeout(() => controller.abort(), 8000);
						const response = await fetch("/dsh-token-usage/balance", {
							signal: controller.signal,
							headers: { Accept: "application/json" }
						});
						clearTimeout(timer);
						if (cancelled) return;
						if (!response.ok) {
							setBalance(null);
							return;
						}
						const data = await response.json();
						if (!cancelled) setBalance(data);
					}
					catch {
						if (!cancelled) setBalance(null);
					}
				};
				load();
				const interval = setInterval(load, 60000);
				return () => {
					cancelled = true;
					clearInterval(interval);
				};
			}, []);
			return balance;
		}
		/** Composer-dock balance chip: one muted line under the input card,
		 * rendered BEFORE the built-in stats footer (dock order -10). */
		function BalanceChip({ t }) {
			const balance = useApiBalance();
			const text = balanceSummaryText(balance);
			if (text === void 0) return null;
			return react_jsx_runtime.jsx("div", {
				style: {
					textAlign: "center",
					margin: "0 auto",
					padding: "2px 0 0",
					fontSize: 12,
					lineHeight: "18px",
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: `${t("balance")} ${text}`
			});
		}
		/** Reduce the DeepSeek /user/balance payload to a short display string. */
		function balanceSummaryText(balance) {
			if (balance == null || typeof balance !== "object") return void 0;
			if (balance.is_available === false || !Array.isArray(balance.balance_infos)) return void 0;
			const byCurrency = {};
			for (const info of balance.balance_infos) {
				const value = Number(info == null ? void 0 : info.total_balance);
				if (!Number.isFinite(value) || value <= 0) continue;
				const currency = String(info.currency ?? "CNY");
				byCurrency[currency] = (byCurrency[currency] ?? 0) + value;
			}
			const entries = Object.entries(byCurrency);
			if (entries.length === 0) return void 0;
			const symbol = (currency) => currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
			return entries.map(([currency, value]) => `${symbol(currency)}${value.toFixed(2)}`).join(" · ");
		}
		/** Dictionary namespace owned by this plugin. */
		const NS = "tokenUsage";
		/** Services required by this client plugin. */
		const inject = ["slots", "locale"];
		/** Register the token-usage card into the sidebar footer. */
		function apply(ctx) {
			injectMobileCss();
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-token-usage: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "token-balance",
				order: -10,
				locale: NS,
				inject: () => ({})
			}, BalanceChip));
		}
      return { apply, inject }
    })()


    const React = require('react')

    // ===== dsh-long-plugins: mobile hamburger (hide rail, overlay sidebar) =====
    const MOBILE_HAMBURGER_CSS = `
      @media (max-width: 767px){
        .pI_x6G_frame{grid-template-columns:0 minmax(0,1fr) 0!important}
        .pI_x6G_sidebarCol{grid-column:1;position:fixed!important;left:0;top:0;bottom:0;width:min(300px,85vw)!important;z-index:30;transform:translateX(-100%);transition:transform .22s var(--ds-ease-in-out);box-shadow:var(--dsw-shadow-lv3)}
        .pI_x6G_frame:not([data-sidebar-collapsed]) .pI_x6G_sidebarCol{transform:translateX(0)}
        .pI_x6G_centerCol{grid-column:2}
        .pI_x6G_detailsCol{grid-column:3}
        .pI_x6G_handle[data-side=sidebar]{display:none}
        .wSkVaW_header{padding-left:calc(env(safe-area-inset-left, 0px) + 56px)!important}
        .dsh-mobile-hamburger{pointer-events:auto;position:fixed;left:calc(env(safe-area-inset-left, 0px) + 10px);top:calc(env(safe-area-inset-top, 0px) + 10px);z-index:45;width:38px;height:38px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1;cursor:pointer;padding:0}
        .dsh-mobile-hamburger:active{transform:scale(.95)}
        .dsh-mobile-scrim{pointer-events:auto;position:fixed;inset:0;z-index:26;background:rgba(0,0,0,.35)}
      }
      @media (min-width: 768px){.dsh-mobile-hamburger,.dsh-mobile-scrim{display:none!important}}
    `

    function MobileHamburger({ toggleSidebar }) {
      const [expanded, setExpanded] = React.useState(false)
      React.useEffect(() => {
        const overlay = document.querySelector('[data-shell-overlay]')
        const frame = overlay ? overlay.parentElement : null
        if (!frame) return
        const update = () => setExpanded(!frame.hasAttribute('data-sidebar-collapsed'))
        update()
        const mo = new MutationObserver(update)
        mo.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
        return () => mo.disconnect()
      }, [])
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          className: 'dsh-mobile-hamburger',
          'aria-label': expanded ? '收起侧边栏' : '打开侧边栏',
          onClick: toggleSidebar,
        }, expanded ? '✕' : '☰'),
        expanded && React.createElement('div', { className: 'dsh-mobile-scrim', onClick: toggleSidebar }),
      )
    }

    const mobilePlugin = {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-long-plugins'
          style.dataset.pluginCss = 'dsh-long-plugins/mobile-hamburger'
          style.textContent = MOBILE_HAMBURGER_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-long-plugins: mobile hamburger styles')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-mobile-hamburger',
          order: 100,
          inject: () => ({ toggleSidebar: () => ctx.layout.toggleSidebar() }),
        }, MobileHamburger))
      },
    }

    const inject = Array.from(new Set([
      ...uploadPlugin.inject,
      ...skillDocsPlugin.inject,
      ...tokenUsagePlugin.inject,
      ...mobilePlugin.inject,
    ]))

    function apply(ctx) {
      uploadPlugin.apply(ctx)
      skillDocsPlugin.apply(ctx)
      tokenUsagePlugin.apply(ctx)
      mobilePlugin.apply(ctx)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
