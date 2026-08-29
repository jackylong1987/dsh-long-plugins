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

    /** Extensions the browser can render inline (image/office handled separately). */
    const INLINE_PREVIEW_EXTS = new Set([
      '.pdf', '.txt', '.md', '.markdown', '.json', '.yml', '.yaml', '.xml', '.html', '.htm',
      '.csv', '.tsv', '.log', '.ini', '.conf', '.env', '.toml', '.rtf',
      '.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.css', '.sql', '.rs', '.go', '.c', '.h', '.cpp',
      '.java', '.kt', '.swift', '.rb', '.php', '.vue', '.jsx', '.tsx',
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif',
    ])

    /** Whether a file can be previewed inline in the browser. */
    function isInlinePreviewable(name) {
      return INLINE_PREVIEW_EXTS.has(extnameOf(name).toLowerCase())
    }

    /** Extension of a file name (with dot), or '' when none. */
    function extnameOf(name) {
      const i = String(name).lastIndexOf('.')
      return i > 0 ? String(name).slice(i) : ''
    }

    /** Upper-case type label for a file name (e.g. 'PDF', 'DOCX', 'MD'), or 'FILE' when unknown. */
    function fileTypeLabel(name) {
      const ext = extnameOf(name).replace(/^\./, '')
      return ext ? ext.toUpperCase() : 'FILE'
    }

    /** Basename of a path without its final extension (keeps the folder prefix intact). */
    function basenameWithoutExt(path) {
      const base = String(path).split(/[\\/]/).pop() || String(path)
      return base.replace(/\.[^.]+$/, '')
    }

    /** 轻量 toast：短暂显示一条消息（用于「粘贴的文件格式不支持」等提示）。 */
    function showToast(text, kind) {
      let t = document.querySelector('.dsh-long-toast')
      if (!t) {
        t = document.createElement('div')
        t.className = 'dsh-long-toast'
        document.body.appendChild(t)
      }
      t.textContent = text
      t.className = 'dsh-long-toast ' + (kind || '') + ' show'
      clearTimeout(t._timer)
      t._timer = setTimeout(() => { t.className = 'dsh-long-toast' }, 2800)
    }

    /** 复制文本到剪贴板 + 轻提示。 */
    function copyText(text) {
      try {
        const done = () => showToast(`已复制：${text}`)
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => showToast('复制失败', 'error'))
        } else {
          const ta = document.createElement('textarea')
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
          done()
        }
      } catch (e) { showToast('复制失败', 'error') }
    }

    /** Trigger a browser download for a URL (no navigation, keeps the page). */
    function triggerDownload(url, name) {
      const a = document.createElement('a')
      a.href = url
      a.download = name || ''
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
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
        this.sinkHooked = new Set()
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
        // 不再往草稿插入引用 token；文件仅以卡片形式显示在输入区上方，
        // 发送时由 ensureSinkHook 安装的 defaultSink 包装统一拼进消息。
        this.ensureSinkHook(key)
        const next = [...this.pendingFor(key), entry]
        this.pending.set(key, next)
        this.refIndex.set(entry.ref, { sessionId: key, entry })
        this.publish(key)
        return entry
      }

      ensureSinkHook(key) {
        const k = String(key)
        if (this.sinkHooked.has(k)) return
        let shell
        try {
          shell = this.scope(k).shell
        } catch (error) {
          return
        }
        const deps = shell.deps
        const original = deps && deps.defaultSink
        if (typeof original !== 'function') return
        this.sinkHooked.add(k)
        const controller = this
        deps.defaultSink = function (text, imageIds, mode, signal) {
          const entries = controller.pendingFor(k)
          let extra = ''
          for (const entry of entries) extra += serializedFile(entry)
          if (entries.length > 0) {
            controller.pending.delete(k)
            controller.inFlight.set(k, entries)
            controller.publish(k)
          }
          const result = original(text + extra, imageIds, mode, signal)
          if (entries.length === 0) return result
          return Promise.resolve(result).then((outcome) => {
            if (outcome && outcome.kind === 'success') {
              const expiry = controller.expiry.get(k)
              if (expiry) expiry()
              controller.expiry.delete(k)
              controller.inFlight.delete(k)
              for (const entry of entries) controller.refIndex.delete(entry.ref)
            }
            return outcome
          })
        }
      }

      remove(sessionId, ref) {
        const key = String(sessionId)
        const entries = this.pendingFor(key)
        const entry = entries.find((item) => item.ref === ref)
        if (!entry) return
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
        // 卡片模式：文件不再以草稿引用/occurrence 形式存在，[pending] 的发送与失败
        // 恢复改由 ensureSinkHook 的 defaultSink 包装 + restoreFailed 负责；这里不再按
        // occurrence 对账，避免草稿一变就把待发送卡片误判为已发送而提前清空。
        return
      }

      restoreFailed(sessionId) {
        const key = String(sessionId)
        const entries = this.inFlight.get(key)
        if (!entries || entries.length === 0) return
        const expiry = this.expiry.get(key)
        if (expiry) expiry()
        this.expiry.delete(key)
        this.inFlight.delete(key)
        // 卡片模式：失败时只把文件恢复为待发送卡片（不再回写草稿/插入引用）。
        this.pending.set(key, entries)
        for (const entry of entries) this.refIndex.set(entry.ref, { sessionId: key, entry })
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
        // 旧格式草稿兼容：只清理残留的「上传文件：`路径`」文本行，不再重新挂载附件。
        // （原先会把它转成待发送附件，导致刷新后幽灵文件反复出现——2026-08-19 修复）
        const key = String(sessionId)
        if (this.migrated.has(key)) return
        this.migrated.add(key)
        const paths = legacyUploadPaths(draft)
        if (paths.length === 0) return
        try {
          const { shell } = this.scope(sessionId)
          shell.setDraft(stripLegacyPaths(shell.snapshot.draft, paths))
        } catch (error) {
          console.error('[dsh-upload-manager] legacy draft cleanup failed', error)
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
        this.sinkHooked.clear()
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

    // ===== 拖放上传：把本地文件拖到会话框任意位置即可加入本条消息 =====
    // 复用与钉选上传完全相同的 uploadFile() + controller.attach() 管线；
    // 监听 window 级 dragenter/dragover/dragleave/drop（仅在携带 Files 时接管），
    // 视觉层用 fixed 全屏遮罩提示，pointer-events:none 保证不干扰拖拽本身。
    function DragDropOverlay(props) {
      const controller = props.controller
      const sessionId = props.sessionId
      const [active, setActive] = React.useState(false)
      const counterRef = React.useRef(0)

      React.useEffect(() => {
        // 只在真正拖入「文件」时才接管；拖文本/链接等（无 Files）一律放行给 DSH 原生行为。
        // 四个事件都用 捕获阶段(capture) + stopPropagation，让本插件成为文件拖放的
        // 唯一所有者 —— 这样 DSH 核心的「图像拖放/粘贴」验证器不会触发（否则非图片文件
        // 会报「仅支持 PNG、JPG、WebP、GIF」），核心自己的拖放遮罩也不会出现/卡住。
        const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))
        const onDragEnter = (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.stopPropagation()
          counterRef.current += 1
          setActive(true)
        }
        const onDragOver = (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.stopPropagation()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        }
        const onDragLeave = (e) => {
          if (!hasFiles(e)) return
          e.stopPropagation()
          counterRef.current -= 1
          if (counterRef.current <= 0) {
            counterRef.current = 0
            setActive(false)
          }
        }
        const onDrop = async (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.stopPropagation()
          counterRef.current = 0
          setActive(false)
          const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
          if (files.length === 0) return
          // 复用与回形针完全相同的 uploadFile + attach 管线；结果直接体现在输入区上方的
          // 「待发送文件」卡片上。
          for (const file of files) {
            try {
              const stored = await uploadFile(file)
              controller.attach(sessionId, stored)
            } catch (error) {
              console.warn(`[dsh-long-plugins] 拖放上传失败：${file.name} → ${errorMessage(error)}`)
            }
          }
        }
        // 粘贴非图片文件 → 走与回形针/拖放相同的上传管线，并阻止 DSH 核心的「仅支持图片」门；
        // 纯文本/图片粘贴放行给 DSH 原生；上传失败（不支持的格式等）给可见提示。
        const onPaste = async (e) => {
          const cd = e.clipboardData
          if (!cd) return
          const files = []
          const items = cd.items
          if (items) {
            for (const item of items) {
              if (item.kind === 'file' && typeof item.getAsFile === 'function') {
                const f = item.getAsFile()
                // 只接管非图片文件；图片交给 DSH 原生（内联显示），避免改变已有行为
                if (f && f.size > 0 && !(f.type || '').startsWith('image/')) files.push(f)
              }
            }
          }
          if (files.length === 0) return // 无「非图片文件」→ 放行给 DSH
          // 有文件粘贴：接管整段粘贴，阻止 DSH 后续处理器报「仅支持图片」
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          for (const file of files) {
            try {
              const stored = await uploadFile(file)
              controller.attach(sessionId, stored)
            } catch (error) {
              console.warn(`[dsh-long-plugins] 粘贴上传失败：${file.name} → ${errorMessage(error)}`)
              showToast(`不支持该文件格式：${file.name}`, 'error')
            }
          }
        }
        window.addEventListener('dragenter', onDragEnter, true)
        window.addEventListener('dragover', onDragOver, true)
        window.addEventListener('dragleave', onDragLeave, true)
        window.addEventListener('drop', onDrop, true)
        window.addEventListener('paste', onPaste, true)
        return () => {
          window.removeEventListener('dragenter', onDragEnter, true)
          window.removeEventListener('dragover', onDragOver, true)
          window.removeEventListener('dragleave', onDragLeave, true)
          window.removeEventListener('drop', onDrop, true)
          window.removeEventListener('paste', onPaste, true)
        }
      }, [controller, sessionId])

      if (!active) return null

      return React.createElement(
        'div',
        { className: 'dsh-upload-dropzone' },
        React.createElement(
          'div',
          { className: 'dsh-upload-dropzone-card' },
          React.createElement(
            'div',
            { className: 'dsh-upload-dropzone-icon' },
            React.createElement(PaperclipIcon, null)
          ),
          React.createElement(
            'div',
            { className: 'dsh-upload-dropzone-text' },
            '松开鼠标，将文件加入本条消息'
          )
        )
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

    /** 本地时区 YYYY-MM-DD（日期筛选/分组用，避免 toISOString 的 UTC 漂移）。 */
    const localDay = (ts) => {
      const d = new Date(ts)
      const p = (v) => v < 10 ? '0' + v : v
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }

    /** 文件名搜索过滤：空格分隔的每个词都需命中（不区分大小写，匹配文件名+路径）。 */
    const matchesSearch = (file, search) => {
      const q = String(search || '').trim().toLowerCase()
      if (!q) return true
      const hay = ((file.name || '') + ' ' + (file.path || '')).toLowerCase()
      return q.split(/\s+/).filter(Boolean).every((tok) => hay.indexOf(tok) !== -1)
    }

    /** 自定义日期筛选控件：显示 📅 + 文字，点击/触摸打开系统日期选择器，自带 ✕ 清除。
     * 原生 input[type=date] 在手机端是空框、无图标；此处整个控件包一层 onClick，
     * 统一调用 input.showPicker()，故点图标/文字/任意位置都触发（桌面/手机一致）。 */
    function DateFilter({ value, onChange, placeholder }) {
      const ref = React.useRef(null)
      const label = value || placeholder || '选择日期'
      const open = () => {
        const el = ref.current
        if (!el) return
        if (typeof el.showPicker === 'function') { try { el.showPicker(); return } catch (e) {} }
        try { el.focus() } catch (e) {}
      }
      return React.createElement('div', { className: 'dsh-datefilter', onClick: open },
        React.createElement('span', { className: 'dsh-datefilter-icon' }, '📅'),
        React.createElement('span', { className: 'dsh-datefilter-text' }, label),
        value !== '' && React.createElement('button', {
          type: 'button', className: 'dsh-datefilter-clear', title: '清除', 'aria-label': '清除日期',
          onClick: (e) => { e.stopPropagation(); onChange('') },
        }, '✕'),
        React.createElement('input', {
          ref, type: 'date', className: 'dsh-datefilter-native', value,
          onChange: (e) => onChange(e.target.value),
          tabIndex: -1, 'aria-label': placeholder || '选择日期',
        }),
      )
    }

    /** 🔍 放大镜搜索：点击图标弹出搜索框，输入即过滤；✕ 清除并关闭。不自动隐藏（需人工关闭或刷新）。 */
    function SearchPopup({ value, onChange, placeholder }) {
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState({ top: 72, left: 8 })
      const ref = React.useRef(null)
      React.useEffect(() => { if (open && ref.current) { try { ref.current.focus() } catch (e) {} } }, [open])
      const toggle = (e) => {
        if (!open && e && e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect()
          setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left, (window.innerWidth || 0) - 280)) })
        }
        setOpen((o) => !o)
      }
      return React.createElement('div', { className: 'dsh-searchpop' },
        React.createElement('button', {
          type: 'button', className: 'dsh-searchpop-btn',
          onClick: toggle,
          title: '搜索文件名', 'aria-label': '搜索文件名',
        }, '🔍'),
        open && React.createElement('div', { className: 'dsh-searchpop-box', style: { top: pos.top, left: pos.left } },
          React.createElement('input', {
            ref, type: 'text', className: 'dsh-searchpop-input', value,
            onChange: (e) => onChange(e.target.value), placeholder: placeholder || '搜索文件名…', autoFocus: true,
          }),
          value !== '' && React.createElement('button', {
            type: 'button', className: 'dsh-searchpop-clear', title: '清除', 'aria-label': '清除搜索',
            onMouseDown: (e) => { e.preventDefault(); e.stopPropagation() },
            onClick: (e) => { e.preventDefault(); e.stopPropagation(); onChange(''); setOpen(false); },
          }, '✕'),
        ),
      )
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
      const [dayFilter, setDayFilter] = React.useState('')
      const [search, setSearch] = React.useState('')
      const [deleteEnabled, setDeleteEnabled] = React.useState(false)

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
          if (preview !== null && preview.name === name) closePreview()
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
            // 先打开弹窗并提示转换中（NAS 上 docx/xlsx 转换可能耗时 1~2 秒）
            setPreview({ name, officeLoading: true })
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
          // 无法内嵌预览的类型（压缩包、程序、视频、字体等）：点预览直接下载。
          if (!isInlinePreviewable(name)) {
            triggerDownload(downloadUrl(name), name)
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
          // PDF / txt / 其它可内嵌文件：弹窗内嵌预览（iframe 指向预览端点），
          // 只有用户点「打开」才在新浏览器标签中打开。
          setPreview({ url: previewUrl(name), name })
        } catch (error) {
          setState((current) => ({ ...current, error: errorMessage(error) }))
        }
      }

      function closePreview() {
        if (preview?.url) URL.revokeObjectURL(preview.url)
        setPreview(null)
      }

      /** Group files by calendar day of their modifiedAt (YYYY-MM-DD, desc). */
      function groupFilesByDate(files) {
        const groups = []
        const byDay = new Map()
        for (const file of files) {
          let day = ''
          try {
            day = localDay(file.modifiedAt)
          } catch {
            day = '未知日期'
          }
          if (!byDay.has(day)) byDay.set(day, [])
          byDay.get(day).push(file)
        }
        const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a))
        for (const day of days) groups.push({ day, files: byDay.get(day) })
        return groups
      }
      // 日期筛选 + 文件名搜索：先按所选天/关键词过滤 state.files，再始终按天分组（空=全部）。
      const shownFiles = (dayFilter || search)
        ? state.files.filter((f) => (dayFilter ? (() => { try { return localDay(f.modifiedAt) === dayFilter } catch { return false } })() : true) && matchesSearch(f, search))
        : state.files
      const dateGroups = groupFilesByDate(shownFiles)

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
            'div',
            { className: 'dsh-upload-head-actions' },
            React.createElement(SearchPopup, { value: search, onChange: setSearch, placeholder: '搜索文件名…' }),
            React.createElement(DateFilter, { value: dayFilter, onChange: setDayFilter, placeholder: '选择日期' }),
            React.createElement(
              'button',
              { type: 'button', className: 'dsh-upload-refresh', disabled: state.loading, onClick: refresh },
              state.loading ? '刷新中…' : '刷新',
            ),
            React.createElement(
              'label',
              { className: 'dsh-upload-del-toggle' },
              React.createElement('input', { type: 'checkbox', checked: deleteEnabled, onChange: (e) => setDeleteEnabled(e.target.checked) }),
              '开启删除',
            ),
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
        !state.loading && (dayFilter !== '' || search !== '') && shownFiles.length === 0 && state.files.length > 0
          ? React.createElement('div', { className: 'dsh-upload-empty' }, '没有匹配的文件。')
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
                  React.createElement(
                    'div',
                    { className: 'dsh-upload-preview-actions', style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    !preview.officeLoading && !(preview.url && preview.url.startsWith('blob:')) && preview.name !== void 0
                      ? React.createElement('a', { href: preview.officeHtml !== void 0 ? downloadUrl(preview.name) : previewUrl(preview.name), target: '_blank', rel: 'noopener noreferrer', className: 'dsh-upload-preview-open' }, '打开')
                      : null,
                    !preview.officeLoading && !(preview.url && preview.url.startsWith('blob:')) && preview.name !== void 0
                      ? React.createElement('a', { href: downloadUrl(preview.name), download: preview.name, className: 'dsh-upload-preview-open' }, '下载')
                      : null,
                    React.createElement('button', { type: 'button', onClick: () => setPreviewMaximized((m) => !m) }, previewMaximized ? '还原' : '放大'),
                    React.createElement('button', { type: 'button', className: 'dsh-upload-preview-del', disabled: deleting === preview.name, onClick: () => remove(preview.name) }, deleting === preview.name ? '删除中…' : '删除'),
                    React.createElement('button', { type: 'button', onClick: closePreview }, '关闭'),
                  ),
                ),
                preview.url && preview.url.startsWith('blob:')
                  ? React.createElement('img', { src: preview.url, alt: preview.name, className: 'dsh-upload-preview-img' })
                  : React.createElement(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#fff' } },
                      preview.officeLoading === true
                        ? React.createElement('div', { className: 'dsh-upload-preview-loading' }, '转换中…')
                        : preview.officeHtml !== void 0
                          ? React.createElement('iframe', { title: preview.name, srcDoc: preview.officeHtml, style: previewMaximized ? { width: '100%', height: 'calc(100vh - 60px)', border: 'none', background: '#fff', flex: 1 } : { width: '100%', height: '70vh', border: 'none', background: '#fff' } })
                          : preview.url && /\.pdf$/i.test(preview.name)
                            ? React.createElement('embed', { src: preview.url, type: 'application/pdf', title: preview.name, style: previewMaximized ? { width: '100%', height: 'calc(100vh - 60px)', border: 'none', background: '#fff', flex: 1 } : { width: '100%', height: '70vh', border: 'none', background: '#fff' } })
                            : React.createElement('iframe', { title: preview.name, src: preview.url, style: previewMaximized ? { width: '100%', height: 'calc(100vh - 60px)', border: 'none', background: '#fff', flex: 1 } : { width: '100%', height: '70vh', border: 'none', background: '#fff' } }),
                    ),
              ),
            )
          : null,
        React.createElement(
          'div',
          { className: 'dsh-upload-list' },
          (dateGroups === null ? [{ day: null, files: shownFiles }] : dateGroups).map((group) => React.createElement(
            'div',
            { key: group.day ?? '__all__', className: 'dsh-upload-group' },
            group.day !== null
              ? React.createElement(
                  'div',
                  { className: 'dsh-upload-group-day' },
                  group.day,
                  React.createElement('span', null, `${group.files.length} 个文件`),
                )
              : null,
            group.files.map((file) => React.createElement(
              'div',
              { className: 'dsh-upload-row', key: file.name },
              React.createElement(
                'span',
                { className: 'dsh-upload-file-name', title: file.path },
                React.createElement('span', { className: 'dsh-upload-file-label' }, file.name.replace(/\.[^.]+$/, '')),
                React.createElement('span', { className: 'dsh-upload-file-type' }, fileTypeLabel(file.name)),
              ),
              React.createElement('span', { className: 'dsh-upload-file-meta' }, `${sizeText(file.size)} · ${dateText(file.modifiedAt)}`),
              React.createElement(
                'div',
                { className: 'dsh-upload-actions' },
                React.createElement(
                  'button',
                  { type: 'button', className: 'dsh-upload-copy', onClick: () => {
                    const s = String(file.path || file.name)
                    const base = state.root ? String(state.root).replace(/\/[^/]*$/, '') : ''
                    copyText(base && s.indexOf(base) === 0 ? s.slice(base.length).replace(/^\/+/, '') : s)
                  } },
                  '复制路径',
                ),
                React.createElement(
                  'button',
                  { type: 'button', disabled: !deleteEnabled || deleting === file.name, onClick: () => remove(file.name) },
                  deleting === file.name ? '删除中…' : '删除',
                ),
                React.createElement('a', { href: downloadUrl(file.name), download: file.name }, '下载'),
                React.createElement('button', { type: 'button', className: 'dsh-upload-preview', onClick: () => previewFile(file.name) }, '预览'),
              ),
            )),
          )),
        ),
      )
    }

    const CSS = `
      @font-face{font-family:DshChipCellInput;src:url(data:font/ttf;base64,AAEAAAAKAIAAAwAgT1MvMkT8SmIAAAEoAAAAYGNtYXAADQBPAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZCwtPGoAAACsAAAANmhoZWEDIg7bAAAA5AAAACRobXR4EZQAAAAAAYgAAAAIbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lvljk2gAAAdAAAABscG9zdNNweNQAAAI8AAAALQABAAAAAQAAdia1tV8PPPUAAwPoAAAAAOaLfcUAAAAA5ot9xQAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAA+gAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwjKAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAPz8/PwAA//z//AMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAD//P//AAD//P//AAUAAQAAAAAAAAAAAAAAAAAAAAAAAAAEADYAAQAAAAAAAQALAAAAAQAAAAAAAgAHAAsAAwABBAkAAQAWABIAAwABBAkAAgAOAChEc2hDaGlwQ2VsbFJlZ3VsYXIARABzAGgAQwBoAGkAcABDAGUAbABsAFIAZQBnAHUAbABhAHIAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABAgZvYmpyZXAAAAA=)format("truetype")}
      .uV2eYG_input,.uV2eYG_mirror{font-family:"DshChipCellInput",var(--dsw-font-family)!important}
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
      .dsh-upload-head-actions{display:flex;gap:8px;align-items:center;flex:none}
      .dsh-searchpop{position:relative;display:inline-flex;align-items:center;flex:none}
      .dsh-searchpop-btn{width:30px;height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      .dsh-searchpop-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dsh-searchpop-box{position:fixed;z-index:60;display:flex;align-items:center;gap:6px;background:var(--dsw-specific-input-major,#0f1720);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:6px;box-shadow:var(--dsw-shadow-lv3);max-width:calc(100vw - 16px)}
      .dsh-searchpop-input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:5px 9px;font:inherit;font-size:12px;line-height:18px;min-width:160px}
      .dsh-searchpop-input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .dsh-searchpop-clear{background:transparent;border:none;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;cursor:pointer;padding:0 3px}
      .dsh-searchpop-clear:hover{color:var(--dsw-alias-label-primary)}
      .dsh-upload-settings h2{margin:0;font-size:20px;line-height:28px}
      .dsh-upload-settings p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      .dsh-upload-refresh,.dsh-upload-actions button,.dsh-upload-actions a{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:6px 11px;font:inherit;font-size:12px;line-height:18px;text-decoration:none;cursor:pointer}
      .dsh-datefilter{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:118px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;padding:5px 8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
      .dsh-datefilter:hover{border-color:var(--dsw-alias-state-business-primary)}
      .dsh-datefilter-icon{font-size:13px;flex:none}
      .dsh-datefilter-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-datefilter-native{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;pointer-events:auto;z-index:1}
      .dsh-datefilter-clear{position:relative;z-index:2;background:transparent;border:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;padding:0 2px}
      .dsh-datefilter-clear:hover{color:var(--dsw-alias-label-primary)}
      .dsh-upload-refresh:hover:not(:disabled),.dsh-upload-actions button:hover:not(:disabled),.dsh-upload-actions a:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-upload-root{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 12px;align-items:center;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-input-major)}
      .dsh-upload-root span{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .dsh-upload-root code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
      .dsh-upload-root small{grid-column:2;color:var(--dsw-alias-label-secondary)}
      .dsh-upload-error{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}
      .dsh-upload-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
      .dsh-upload-list{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l2)}
      .dsh-upload-group{display:flex;flex-direction:column}
      .dsh-upload-group+.dsh-upload-group{margin-top:14px}
      .dsh-upload-group-day{display:flex;align-items:baseline;gap:8px;padding:8px 4px 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
      .dsh-upload-group-day span{font-weight:400;color:var(--dsw-alias-label-tertiary)}
      .dsh-upload-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:13px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform,transparent);margin-bottom:4px}
      .dsh-upload-file-name{flex:1;min-width:0;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary)}
      .dsh-upload-file-label{min-width:0;white-space:normal;word-break:break-all;overflow-wrap:anywhere}
      .dsh-upload-file-type{flex:none;font-size:10px;line-height:14px;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}
      .dsh-upload-file-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .dsh-upload-actions{display:flex;flex:none;gap:7px}
      .dsh-upload-actions button{color:var(--dsw-alias-state-error-primary)}
      .dsh-upload-actions button.dsh-upload-copy{color:var(--dsw-alias-label-primary)}
      .dsh-upload-actions button:disabled{opacity:.5;cursor:not-allowed;color:var(--dsw-alias-label-tertiary)}
      .dsh-upload-del-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;user-select:none}
      .dsh-upload-del-toggle input{accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
      .dsh-ws-del:disabled{opacity:.5;cursor:not-allowed;color:var(--dsw-alias-label-tertiary)!important}
      .dsh-upload-actions a,.dsh-upload-actions button{white-space:nowrap}
      @media (max-width:640px){.dsh-upload-row{align-items:stretch;flex-direction:column;gap:4px}.dsh-upload-file-name{white-space:normal;word-break:break-all}.dsh-upload-actions{width:100%;display:flex;gap:6px}.dsh-upload-actions a,.dsh-upload-actions button{flex:1;text-align:center;white-space:nowrap;padding:6px 4px}.dsh-upload-chip{min-width:160px}.dsh-upload-settings-head{flex-direction:column;align-items:stretch;gap:10px}.dsh-upload-head-actions{width:100%;flex-wrap:nowrap;justify-content:flex-start}.dsh-upload-head-actions .dsh-searchpop,.dsh-upload-head-actions .dsh-datefilter{flex:1 1 0;min-width:0}.dsh-upload-head-actions .dsh-upload-refresh{flex:none;text-align:center;padding:7px 8px;max-width:none}.dsh-upload-head-actions .dsh-upload-del-toggle{flex:none;white-space:nowrap;padding:0 4px}}
      .dsh-ws-folder:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-ws-file-type{flex:none;font-size:10px;line-height:14px;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}
      .dsh-upload-preview-del{color:var(--dsw-alias-state-error-primary)!important}
      @media (max-width: 767px){ .dsh-upload-preview-head{padding:8px 10px;gap:8px;flex-direction:column;align-items:stretch!important} .dsh-upload-preview-head strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .dsh-upload-preview-actions{flex-wrap:wrap;justify-content:flex-start} .dsh-upload-preview-actions a,.dsh-upload-preview-actions button{flex:1 1 auto;min-width:56px;text-align:center;padding:5px 8px;font-size:11px}
        .dsh-ws-row{flex-direction:column!important;align-items:stretch!important;gap:4px!important}
        .dsh-ws-name{white-space:normal!important;word-break:break-all}
        .dsh-ws-meta{font-size:11px}
        .dsh-ws-actions{width:100%;display:flex!important;gap:6px}
        .dsh-ws-actions button,.dsh-ws-actions a{flex:1;text-align:center;padding:5px 4px}
      }
      .dsh-upload-actions button.dsh-upload-preview{color:var(--dsw-alias-label-primary)}
      .dsh-upload-dropzone{position:fixed;inset:0;z-index:1350;pointer-events:none;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-specific-input-major,#0f1720) 55%,transparent);backdrop-filter:blur(2px)}
      .dsh-upload-dropzone-card{display:flex;align-items:center;gap:14px;padding:22px 30px;border:2px dashed var(--dsw-alias-state-business-primary,#3b82f6);border-radius:16px;background:color-mix(in srgb,var(--dsw-specific-input-major,#0f1720) 92%,transparent);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
      .dsh-upload-dropzone-icon{width:42px;height:42px;display:grid;place-items:center;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,#3b82f6)}
      .dsh-upload-dropzone-icon svg{width:28px;height:28px;display:block}
      .dsh-upload-dropzone-text{font-size:15px;line-height:22px;color:var(--dsw-alias-label-primary)}
      .dsh-upload-preview-overlay{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}
      .dsh-upload-preview-overlay-max{padding:0}
      .dsh-upload-preview-card{box-sizing:border-box;background:var(--dsw-specific-input-major);border-radius:14px;max-width:min(560px,100%);max-height:90%;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--dsw-shadow-lv3)}
      .dsh-upload-preview-card-max{width:100%;height:100%;max-width:none;max-height:none;border-radius:0}
      .dsh-upload-preview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}
      .dsh-upload-preview-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
      .dsh-upload-preview-head button{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:5px 12px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;flex:none}
      .dsh-upload-preview-open{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-state-business-primary);padding:5px 12px;font:inherit;font-size:12px;text-decoration:none;cursor:pointer;white-space:nowrap;flex:none}
      .dsh-upload-preview-open:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-upload-preview-img{max-width:100%;max-height:70vh;object-fit:contain;display:block}
      .dsh-upload-preview-loading{display:flex;align-items:center;justify-content:center;flex:1;min-height:120px;color:var(--dsw-alias-label-secondary);font-size:13px}
      .dsh-long-toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%) translateY(12px);z-index:2000;max-width:min(90vw,520px);padding:10px 16px;border-radius:10px;background:var(--dsw-specific-input-major,#0f1720);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;box-shadow:var(--dsw-shadow-lv3);opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease}
      .dsh-long-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
      .dsh-long-toast.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
    `

    const inject = ['slots', 'sessions', 'inputTriggers', 'conversation', 'timer']

        function WorkspaceFilesSection() {
      const [groups, setGroups] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState({})
      const [dayFilter, setDayFilter] = React.useState('')
      const [search, setSearch] = React.useState('')
      const [deleteEnabled, setDeleteEnabled] = React.useState(false)
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

      // md 预览是 iframe 内嵌 workspace-preview 页面，页面自带「关闭」按钮，
      // 通过 postMessage 通知本组件关闭预览窗（放大态下同样生效）。
      // 仅当本组件预览窗开着且内容来自 iframe 时才响应，避免误关其它内联预览。
      React.useEffect(() => {
        const onMessage = (event) => {
          if (event.origin !== window.location.origin) return
          if (event.data && event.data.type === 'dsh-close-preview') {
            setPreview((current) => (current !== null && current.url !== void 0 ? null : current))
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      const openPreview = async (path) => {
        const isOffice = /\.(docx|xlsx|pptx)$/i.test(path)
        setPreview({ path, loading: true, officeLoading: isOffice })
        try {
          const res = await fetch('/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(path), { headers: { Accept: 'application/json' } })
          const data = await res.json()
          if (data.ok === true) {
            const isBinaryOther = data.binary === true && data.officeHtml === void 0
            if (isBinaryOther) {
              // 二进制且非 Office：PDF 等浏览器可直接渲染的类型 → 弹窗 iframe
              // 直接嵌原始文件流（inline）；否则（压缩包/程序等）直接下载。
              if (isInlinePreviewable(path)) {
                setPreview({ path, name: data.name, url: '/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(path) + '&inline=1' })
              } else {
                setPreview(null)
                triggerDownload('/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(path) + '&download=1', data.name)
              }
            } else if (/\.(md|markdown)$/i.test(path)) {
              // Markdown：用服务端渲染的 mdHtml（srcDoc 进外层 iframe），外层标题栏
              // 完全控制（编辑/复制/删除/放大/关闭）；放大=外层真正全屏，按钮不重复。
              // content 保留源码供「编辑/复制」使用（mdHtml 只用于预览展示）。
              setPreview({ path, name: data.name, mdHtml: data.mdHtml, content: data.content })
            } else if (/\.docx$/i.test(path)) {
              // docx：走 docx-preview 真实渲染页（浏览器端解析，所见即所得），
              // 而非 mammoth 简化 HTML。url 指向 docx-preview 端点。
              setPreview({ path, name: data.name, url: '/api/dsh-uploads/docx-preview?path=' + encodeURIComponent(path) })
            } else if (/\.pptx$/i.test(path)) {
              // pptx：走 PptxViewJS 真实渲染页（浏览器端 Canvas 渲染，所见即所得）。
              setPreview({ path, name: data.name, url: '/api/dsh-uploads/pptx-preview?path=' + encodeURIComponent(path) })
            } else if (/\.xlsx$/i.test(path)) {
              // xlsx：走 x-spreadsheet 真实渲染页（浏览器端解析 xlsx，所见即所得）。
              setPreview({ path, name: data.name, url: '/api/dsh-uploads/xlsx-preview?path=' + encodeURIComponent(path) })
            } else {
              setPreview(data)
            }
          } else {
            setPreview({ path, error: data.error })
          }
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
            // 保存后：更新 content，并重新渲染 mdHtml（若为 markdown），保证预览同步。
            const updated = { ...preview, content: edited, truncated: false }
            if (preview.mdHtml !== void 0) {
              try {
                const res2 = await fetch('/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(preview.path), { headers: { Accept: 'application/json' } })
                const d2 = await res2.json().catch(() => ({}))
                if (d2.ok === true && typeof d2.mdHtml === 'string') updated.mdHtml = d2.mdHtml
              } catch { /* 刷新失败则保留现状 */ }
            }
            setPreview(updated)
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
      const nameStyle = { flex: 1, minWidth: 0, whiteSpace: 'normal', wordBreak: 'break-all', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary)' }
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

      // 日期筛选：按所选天过滤各组文件，隐藏空组（空日期=全部）。
      const shownGroups = ((dayFilter || search) && groups !== null)
        ? groups
          .map((g) => ({ folder: g.folder, files: g.files.filter((f) =>
            (dayFilter ? (() => { try { return localDay(f.mtime) === dayFilter } catch { return false } })() : true) &&
            matchesSearch(f, search)
          ) }))
          .filter((g) => g.files.length > 0)
        : groups

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '工作区输出文件（按文件夹分类，预览 / 下载 / 删除）'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
          React.createElement(SearchPopup, { value: search, onChange: setSearch, placeholder: '搜索文件名…' }),
          React.createElement(DateFilter, { value: dayFilter, onChange: setDayFilter, placeholder: '选择日期' }),
          React.createElement('label', { className: 'dsh-upload-del-toggle' },
            React.createElement('input', { type: 'checkbox', checked: deleteEnabled, onChange: (e) => setDeleteEnabled(e.target.checked) }),
            '开启删除',
          ),
        ),
        error !== null && React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error),
        groups === null && error === null && React.createElement('div', { style: metaStyle }, '加载中…'),
        groups !== null && groups.length === 0 && React.createElement('div', { style: metaStyle }, '目录为空'),
        (dayFilter || search) && groups !== null && groups.length > 0 && shownGroups !== null && shownGroups.length === 0 && React.createElement('div', { style: metaStyle }, '没有匹配的文件'),
        shownGroups !== null && shownGroups.map((group) => React.createElement(
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
            React.createElement(
              'span',
              { className: 'dsh-ws-name', style: { ...nameStyle, display: 'flex', alignItems: 'center', gap: 6 }, title: f.path },
              React.createElement('span', { className: 'dsh-ws-file-label', style: { flex: 1, minWidth: 0, whiteSpace: 'normal', wordBreak: 'break-all', overflowWrap: 'anywhere' } }, basenameWithoutExt(f.path)),
              React.createElement('span', { className: 'dsh-ws-file-type', style: { flex: 'none' } }, fileTypeLabel(f.path)),
            ),
            React.createElement('span', { className: 'dsh-ws-meta', style: metaStyle }, `${sizeText(f.size)} · ${dateText(f.mtime)}`),
            React.createElement(
              'div',
              { className: 'dsh-ws-actions', style: { display: 'flex', gap: 6, flex: 'none' } },
              React.createElement('button', { type: 'button', style: btnStyle, disabled: busy, onClick: () => copyText(f.path) }, '复制路径'),
              React.createElement('button', { type: 'button', className: 'dsh-ws-del', style: delStyle, disabled: !deleteEnabled || busy, onClick: () => doDelete(f.path) }, '删除'),
              React.createElement('a', { href: '/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(f.path) + '&download=1', download: f.name, style: btnStyle }, '下载'),
              React.createElement('button', { type: 'button', style: btnStyle, disabled: busy, onClick: () => openPreview(f.path) }, '预览'),
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
              { className: 'dsh-ws-preview-head', style: previewHeadStyle },
              React.createElement('strong', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 } }, `${preview.name ?? preview.path}`),
              preview.binary !== true && preview.loading !== true && React.createElement('button', { type: 'button', style: btnStyle, disabled: busy, onClick: () => { if (editing) { setEdited(preview.content !== void 0 ? preview.content : ''); setEditing(false); } else { setEdited(preview.content !== void 0 ? preview.content : ''); setEditing(true); } } }, editing ? '取消编辑' : '编辑'),
              editing && React.createElement('button', { type: 'button', style: btnStyle, disabled: busy, onClick: doSave }, savedFlash ? '已保存' : '保存'),
              React.createElement('button', { type: 'button', style: btnStyle, onClick: copyContent }, copied ? '已复制' : '复制全部'),
              (preview.url !== void 0 || preview.officeHtml !== void 0 || preview.mdHtml !== void 0) && preview.loading !== true && React.createElement('a', { href: '/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(preview.path) + '&download=1', download: preview.name, style: { ...btnStyle, color: 'var(--dsw-alias-state-business-primary)' } }, '下载'),
              (preview.url !== void 0 || preview.officeHtml !== void 0 || preview.mdHtml !== void 0) && preview.loading !== true && React.createElement('a', { href: preview.url !== void 0 ? preview.url : '/api/dsh-uploads/workspace-preview?path=' + encodeURIComponent(preview.path), target: '_blank', rel: 'noopener noreferrer', style: { ...btnStyle, color: 'var(--dsw-alias-state-business-primary)' } }, '打开'),
              React.createElement('button', { type: 'button', style: delStyle, disabled: busy, onClick: () => doDelete(preview.path) }, '删除'),
              React.createElement('button', { type: 'button', style: btnStyle, onClick: () => setMaximized((m) => !m) }, maximized ? '还原' : '放大'),
              React.createElement('button', { type: 'button', style: btnStyle, onClick: () => setPreview(null) }, '关闭'),
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' } },
              preview.loading === true && React.createElement('div', { style: { ...metaStyle, padding: 10 } }, '加载中…'),
              preview.error !== void 0 && preview.loading !== true && React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', padding: 10 } }, preview.error),
              preview.officeLoading === true && preview.loading !== true && React.createElement('div', { style: { ...metaStyle, padding: 10 } }, '转换中…'),
              preview.url !== void 0 && preview.loading !== true && (preview.name && /\.pdf$/i.test(preview.name)
                ? React.createElement('embed', { src: preview.url, type: 'application/pdf', title: preview.name ?? preview.path, style: { width: '100%', height: '70vh', minHeight: 0, border: 'none', background: '#fff', flex: 1 } })
                : React.createElement('iframe', { title: preview.name ?? preview.path, src: preview.url, style: { width: '100%', height: '70vh', minHeight: 0, border: 'none', background: '#fff', flex: 1 } })),
              preview.binary === true && preview.officeHtml === void 0 && preview.url === void 0 && React.createElement('div', { style: { ...metaStyle, padding: 10 } }, '二进制文件，无法预览，请下载后查看'),
              preview.officeHtml !== void 0 && React.createElement('iframe', { title: preview.name ?? preview.path, srcDoc: preview.officeHtml, style: { width: '100%', flex: 1, minHeight: 0, border: 'none', background: '#fff' } }),
              preview.mdHtml !== void 0 && editing !== true && React.createElement('iframe', { title: preview.name ?? preview.path, srcDoc: preview.mdHtml, style: { width: '100%', flex: 1, minHeight: 0, border: 'none', background: '#fff' } }),
              editing && preview.binary !== true && React.createElement('textarea', { style: textareaStyle, value: edited, onChange: (e) => setEdited(e.target.value), spellCheck: false }),
              !editing && preview.binary !== true && preview.content !== void 0 && preview.mdHtml === void 0 && React.createElement('pre', { style: preStyle }, preview.content),
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

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'local-file-upload-dropzone',
        order: 90,
        label: '拖放上传',
      }, (props) => React.createElement(DragDropOverlay, { ...props, controller })))

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
		/** 技能文档文件名/路径匹配：空格分词，全部命中才显示。 */
		const skillMatch = (f, q) => {
			const s = String(q || "").trim().toLowerCase();
			if (!s) return true;
			const hay = ((f.name || "") + " " + (f.path || "")).toLowerCase();
			return s.split(/\s+/).filter(Boolean).every((tok) => hay.indexOf(tok) !== -1);
		};
		/** 🔍 放大镜搜索弹窗（技能文档用）：点击弹出搜索框，✕ 清除并关闭。不自动隐藏。 */
		function SkillSearchPop({ value, onChange, placeholder }) {
			const [open, setOpen] = react.useState(false);
			const [pos, setPos] = react.useState({ top: 72, left: 8 });
			const ref = react.useRef(null);
			react.useEffect(() => { if (open && ref.current) { try { ref.current.focus(); } catch (e) {} } }, [open]);
			const toggle = (e) => {
				if (!open && e && e.currentTarget) {
					const r = e.currentTarget.getBoundingClientRect();
					setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left, (window.innerWidth || 0) - 280)) });
				}
				setOpen((o) => !o);
			};
			return react_jsx_runtime.jsxs("div", { className: "dsh-searchpop", children: [
				react_jsx_runtime.jsx("button", { type: "button", className: "dsh-searchpop-btn", onClick: toggle, title: "搜索技能/文件", "aria-label": "搜索技能/文件", children: "🔍" }),
				open && react_jsx_runtime.jsxs("div", { className: "dsh-searchpop-box", style: { top: pos.top, left: pos.left }, children: [
					react_jsx_runtime.jsx("input", { ref, type: "text", className: "dsh-searchpop-input", value, onChange: (e) => onChange(e.target.value), placeholder: placeholder || "搜索技能/文件…", autoFocus: true }),
					value !== "" && react_jsx_runtime.jsx("button", { type: "button", className: "dsh-searchpop-clear", title: "清除", "aria-label": "清除搜索", onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); }, onClick: (e) => { e.preventDefault(); e.stopPropagation(); onChange(""); setOpen(false); }, children: "✕" })
				] })
			] });
		}
		function SkillsSection({ t }) {
			const [groups, setGroups] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [preview, setPreview] = react.useState(null);
			const [collapsed, setCollapsed] = react.useState({});
			const [search, setSearch] = react.useState("");
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

			// 检索：按名称/路径过滤各技能夹的 md 文件，隐藏空夹；检索时自动展开命中夹。
			const shownGroups = (search && groups !== null)
				? groups.map((g) => ({ folder: g.folder, files: g.files.filter((f) => skillMatch(f, search)) })).filter((g) => g.files.length > 0)
				: groups;
			const searching = !!String(search || "").trim();

			return react_jsx_runtime.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
				children: [
					react_jsx_runtime.jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }, children: [
						react_jsx_runtime.jsx("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }, children: t("files.hint") }),
						react_jsx_runtime.jsx(SkillSearchPop, { value: search, onChange: setSearch, placeholder: "搜索技能/文件…" })
					] }),
					error !== null && react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }, children: error }),
					groups === null && error === null && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.loading") }),
					groups !== null && groups.length === 0 && react_jsx_runtime.jsx("div", { style: metaStyle, children: t("files.empty") }),
					shownGroups !== null && shownGroups.map((group) => {
						const isCollapsed = searching ? false : !!collapsed[group.folder];
						return react_jsx_runtime.jsxs("div", {
							style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
							children: [
								react_jsx_runtime.jsx("button", {
									type: "button",
									style: folderBtnStyle,
									"aria-expanded": !isCollapsed,
									onClick: () => toggleFolder(group.folder),
									children: `${isCollapsed ? "▸" : "▾"} ${group.folder} (${group.files.length})`
								}),
								!isCollapsed && group.files.map((f) => react_jsx_runtime.jsxs("div", {
									style: rowStyle,
									children: [
										react_jsx_runtime.jsx("span", { style: nameStyle, title: f.path, children: f.path }),
										react_jsx_runtime.jsx("span", { style: metaStyle, children: `${f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KiB`}` }),
										react_jsx_runtime.jsx("button", { type: "button", style: btnStyle, onClick: () => openDoc(f.path), children: t("files.preview") }),
										react_jsx_runtime.jsx("a", { href: "/dsh-skill-docs/skill-doc?path=" + encodeURIComponent(f.path) + "&download=1", download: f.name, style: btnStyle, children: t("files.download") })
									]
								}, f.path))
							]
						}, group.folder);
					}),
					searching && shownGroups !== null && shownGroups.length === 0 && react_jsx_runtime.jsx("div", { style: metaStyle, children: "没有匹配的技能文档" }),
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
			"balance": "余额",
			"spend": "本会话约"
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
			"balance": "Balance",
			"spend": "~session"
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
		/** Format a CNY figure compactly (up to 4 decimal places for small spends). */
		function formatCny(value) {
			if (value == null || !Number.isFinite(value)) return null;
			if (value >= 1) return `¥${Math.round(value)}`;
			if (value >= 0.01) return `¥${value.toFixed(2)}`;
			return `¥${value.toFixed(3)}`;
		}
		/** Poll the backend session-cost route (peak/off-peak aware, V4-Flash
		 * official pricing) for the given session id. Returns the parsed JSON
		 * `{tokens, cny:{peak,offPeak,total}}` or null while unavailable. */
		function useSessionCost(sessionId) {
			const [cost, setCost] = react.useState(null);
			react.useEffect(() => {
				let cancelled = false;
				if (!sessionId) { setCost(null); return void 0; }
				const load = async () => {
					try {
						const controller = new AbortController();
						const timer = setTimeout(() => controller.abort(), 8000);
						const response = await fetch("/dsh-token-usage/session-cost?session=" + encodeURIComponent(sessionId), {
							signal: controller.signal,
							headers: { Accept: "application/json" }
						});
						clearTimeout(timer);
						if (cancelled) return;
						if (!response.ok) { setCost(null); return; }
						const data = await response.json();
						if (!cancelled) setCost(data && data.ok === true ? data : null);
					}
					catch {
						if (!cancelled) setCost(null);
					}
				};
				load();
				const interval = setInterval(load, 60000);
				return () => {
					cancelled = true;
					clearInterval(interval);
				};
			}, [sessionId]);
			return cost;
		}
		/** Composer-dock balance chip: one muted line under the input card,
		 * rendered BEFORE the built-in stats footer (dock order -10).
		 * Shows account balance, plus the current session's spend (computed
		 * server-side with peak/off-peak V4-Flash pricing) on its right. */
		function BalanceChip({ useSession, t }) {
			const balance = useApiBalance();
			const text = balanceSummaryText(balance);
			const sessionId = useSession((s) => s.sessionId);
			const cost = useSessionCost(sessionId);
			const spendCny = cost && cost.cny && Number.isFinite(cost.cny.total) ? cost.cny.total : null;
			const spendText = spendCny === null || spendCny <= 0 ? null : `${t("spend")}${formatCny(spendCny)}`;
			if (text === void 0 && spendText === null) return null;
			return react_jsx_runtime.jsx("div", {
				style: {
					textAlign: "center",
					margin: "0 auto",
					padding: "2px 0 0",
					fontSize: 12,
					lineHeight: "18px",
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: [text === void 0 ? null : `${t("balance")} ${text}`, spendText].filter(Boolean).join(" | ")
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
        /* 手机端会话标题栏按钮压缩，避免遮挡标题 */
        .dsh-ws-files-btn{padding:4px 8px;font-size:12px}
        .dsh-ws-files-label{display:none}
        .nL4_yW_sessionLogButton{min-width:0!important;height:28px;padding:4px 8px}
        .nL4_yW_sessionLogButton span{display:none!important}
        /* 手机端设置面板：全屏 + 导航横排，内容区全宽（类名随 DSH 版本，升级后需核对） */
        .VOzbGW_overlay{padding:0}
        .VOzbGW_panel{width:100vw;max-width:100vw;height:100vh;max-height:100vh;border-radius:0}
        .VOzbGW_nav{width:100%;flex-direction:row;gap:6px;padding:10px 14px 0;overflow-x:auto;align-items:center;flex:none}
        .VOzbGW_navTitle{display:none}
        .VOzbGW_navList{flex-direction:row;gap:6px}
        .VOzbGW_navCell{height:36px;padding:8px 14px}
        .VOzbGW_header{height:auto;min-height:44px;padding:12px 14px 6px}
        .VOzbGW_options{padding:0 16px 24px}
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

    // ===== dsh-long-plugins: workspace file browser + inline preview =====
    // 共享内联面板状态：标题栏「📂 文件」、消息文件徽章、工具卡片文件名共用
    // 关闭：从列表进入的预览（history 非空）→ 回到文件列表；列表根部 → 整个面板退出。
    const wsOverlay = {
      url: null, title: '', history: [],
      listeners: new Set(),
      open(url, title, keepHistory = false) {
        if (keepHistory && this.url !== null && this.url !== url) {
          this.history.push({ url: this.url, title: this.title })
        }
        this.url = url; this.title = title || ''; this.emit();
      },
      back() {
        const prev = this.history.pop()
        if (prev) { this.url = prev.url; this.title = prev.title; this.emit(); return true }
        return false
      },
      close() { this.url = null; this.title = ''; this.history = []; this.emit(); },
      emit() { this.listeners.forEach((fn) => fn()); },
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    }
    const WORKSPACE_FILES_CSS = `
      .dsh-ws-files-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,#2c3a47);background:transparent;color:var(--dsw-alias-label-primary,#e5e7eb);border-radius:8px;padding:5px 10px;font-size:13px;line-height:1;cursor:pointer;text-decoration:none}
      .dsh-ws-files-btn:hover{background:var(--dsw-alias-border-l2,#2c3a47)}
      .dsh-ws-files-overlay{position:fixed;inset:0;z-index:1200;background:rgba(5,10,16,.66);display:flex;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
      .dsh-ws-files-panel{width:min(1080px,96vw);height:min(820px,92vh);background:var(--dsw-specific-input-major,#0f1720);border:1px solid var(--dsw-alias-border-l2,#2c3a47);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 18px 60px rgba(0,0,0,.55)}
      .dsh-ws-files-panel-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-alias-bg-module-platform,#1a2530);border-bottom:1px solid var(--dsw-alias-border-l2,#2c3a47);flex:none;flex-wrap:nowrap}
      .dsh-ws-files-panel-head .t{flex:1;min-width:0;font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary,#e5e7eb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-ws-files-panel-head .sp{display:none}
      .dsh-ws-files-close{flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2,#2c3a47);background:transparent;color:var(--dsw-alias-label-primary,#e5e7eb);border-radius:8px;padding:5px 10px;font-size:12px;line-height:1;cursor:pointer;text-decoration:none;white-space:nowrap}
      .dsh-ws-files-close:hover{background:var(--dsw-alias-interactive-bg-hover,#2c3a47)}
      .dsh-ws-files-frame{flex:1;border:none;width:100%;background:var(--dsw-specific-input-major,#0f1720)}
      /* 最大化：面板全屏，iframe 撑满 */
      .dsh-ws-files-overlay-max{padding:0}
      .dsh-ws-files-overlay-max .dsh-ws-files-panel{width:100vw;height:100vh;max-width:none;max-height:none;border:none;border-radius:0}
      /* 浅色模式下即使主题变量缺失也保证跟随系统 */
      @media (prefers-color-scheme: light) {
        .dsh-ws-files-panel{background:#ffffff}
        .dsh-ws-files-panel-head{background:#f3f4f6;border-bottom-color:#e5e7eb}
        .dsh-ws-files-panel-head .t{color:#1f2937}
        .dsh-ws-files-close{color:#374151;border-color:#e5e7eb}
        .dsh-ws-files-close:hover{background:#e5e7eb}
        .dsh-ws-files-frame{background:#ffffff}
      }
      /* 会话 markdown 里的预览/下载图标：内联显示在文件名后面（默认 markdown 图片是 block 独占一行） */
      img[src*="/api/dsh-uploads/icons/"]{display:inline!important;width:14px!important;height:14px!important;vertical-align:-2px!important;border-radius:0!important;background:transparent!important;margin:0 1px!important}
      @media (max-width: 640px){
        .dsh-ws-files-overlay{padding:10px}
        .dsh-ws-files-panel-head{gap:6px;padding:8px 10px}
        .dsh-ws-files-close{padding:5px 8px;font-size:12px}
        .dsh-ws-files-panel-head .t{font-size:13px}
      }
      /* 输出文件预览弹窗头部：手机端按钮换行铺开 */
      .dsh-ws-preview-head{flex-wrap:nowrap}
      @media (max-width: 640px){
        .dsh-ws-preview-head{flex-wrap:wrap;gap:6px;padding:8px 10px}
        .dsh-ws-preview-head strong{flex-basis:100%}
        .dsh-ws-preview-head button,.dsh-ws-preview-head a{padding:4px 8px;font-size:12px;flex:1;text-align:center}
      }
    `
    const workspaceFilesPlugin = {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-long-plugins'
          style.dataset.pluginCss = 'dsh-long-plugins/workspace-files-btn'
          style.textContent = WORKSPACE_FILES_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-long-plugins: workspace files button styles')
        // 全局点击拦截：消息文件引用 chip（data-ref-chip）+ 工具卡片文件名 + 产物芯片 → 内联预览。
        // 类名随 DSH 版本变化，故用稳定的 data-ref-chip 语义属性匹配（旧版 _fileMention_*/o3BgMG_* 已失效）；
        // 工作区根路径运行时从服务端获取（避免硬编码本机路径）
        let workspaceRootPromise = null
        const getWorkspaceRoot = () => {
          workspaceRootPromise ??= fetch('/api/dsh-uploads/workspace', { headers: { Accept: 'application/json' } })
            .then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
            .then((d) => (d && d.ok && typeof d.root === 'string') ? stripTrailingSlash(normPath(d.root)) : '')
            .catch(() => '')
          return workspaceRootPromise
        }
        let lastCwd = ''
        // 跨平台路径工具：Windows 用反斜杠 \，Unix 用正斜杠 /。统一规范化为正斜杠，
        // 并识别两种系统的绝对路径（Unix「/」开头；Windows「X:\」盘符或「\\」UNC），
        // 避免 Windows 下把绝对路径误当相对路径去拼 lastCwd（导致双重路径、500）。
        const normPath = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+/g, '/')
        const isAbsPath = (p) => /^(\/|[A-Za-z]:\/|\/\/)/.test(p)
        const stripTrailingSlash = (p) => String(p || '').replace(/\/+$/, '')
        const baseName = (p) => {
          const s = String(p == null ? '' : p).replace(/[\\/]+$/, '')
          return s.split(/[\\/]/).pop() || ''
        }
        const onFileClick = (event) => {
          const target = event.target
          // 匹配 DSH 消息文件引用 chip 的稳定语义属性（data-ref-chip），
          // 而非随 DSH 版本变化的 CSS 哈希类名（旧版 _fileMention_* / o3BgMG_* 已失效）。
          let el = target && target.closest
            ? target.closest('[data-ref-chip], .o3BgMG_fileLink, .P4kPIW_file')
            : null
          // 兜底：匹配看起来像文件路径的可点击元素。
          // 通用判定，不硬编码本机目录（如 /volume1/、workspace/，换机器会失效）：
          // 绝对路径（title 以 / 开头）或以常见文档/办公扩展名结尾。
          // 「是否真的在可打开工作区内」交给下方 rel 解析 + 运行时 workspaceRoot 判定。
          if (!el && target) {
            const t = target.closest
              ? target.closest('[title^="/"], [title$=".docx"], [title$=".md"]')
              : null
            if (t) el = t
          }
          if (!el) return
          // chip 的 title 是完整引用 label（含路径），是获取路径的稳定来源；
          // 否则退回 displayLabel 文字（可能只有文件名）。
          const t = el.getAttribute ? el.getAttribute('title') : null
          const text = (el.textContent || '').trim().replace(/^[📁📄🗂\u200b]/, '')
          const raw = (t && t.length > 0) ? t.trim() : text
          if (!raw) return
          // 兜底匹配到的元素需像文件路径才拦截，避免误伤含 "/" 的工具提示/面包屑。
          const rawNorm = normPath(raw)
          if (!/\.(docx?|md|txt|pdf|xlsx?|pptx?|png|jpe?g|gif|webp|json|ya?ml|html?|css|js|ts|py|sh)$/i.test(rawNorm) && !(isAbsPath(rawNorm) && rawNorm.includes('/'))) return
          event.preventDefault()
          event.stopImmediatePropagation()
          event.stopPropagation()
          // 绝对路径（Windows 盘符或 Unix / 开头）不再拼 lastCwd，避免生成「双重路径」。
          const abs = isAbsPath(rawNorm)
            ? rawNorm
            : (lastCwd ? stripTrailingSlash(normPath(lastCwd)) + '/' + rawNorm.replace(/^\/+/, '') : rawNorm)
          getWorkspaceRoot().then((root) => {
            const rawName = baseName(rawNorm) || text || raw
            // 优先直接用 root 定位；若 raw 本身已含 root 前缀则剥离；否则回退 lastCwd。
            let rel
            if (root) {
              if (rawNorm.startsWith(root + '/')) rel = rawNorm.slice(root.length + 1).replace(/^\/+/, '')
              else if (isAbsPath(rawNorm)) rel = rawNorm.replace(/^\/+/, '')
              else if (abs.startsWith(root + '/')) rel = abs.slice(root.length + 1).replace(/^\/+/, '')
              else rel = abs.replace(/^\/+/, '')
            } else {
              rel = abs.replace(/^\/+/, '')
            }
            const isPdf = /\.pdf$/i.test(rawName)
            // 标题用剥离后的真实文件名（rel 的 basename）而非 chip 的 title/文本，
            // 避免工具卡片「预览」按钮被误当成文件名（出现「预览 · 预览」）。
            const titleName = baseName(rel) || rawName || '文件'
            const url = isPdf
              ? '/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(rel) + '&inline=1'
              : '/api/dsh-uploads/workspace-preview?path=' + encodeURIComponent(rel)
            wsOverlay.open(url, titleName)
          })
        }
        ctx.effect(() => {
          document.addEventListener('click', onFileClick, true)
          return () => document.removeEventListener('click', onFileClick, true)
        }, 'dsh-long-plugins: file mention preview interceptor')
        // 预览页在 iframe 里点「关闭」时，通过 postMessage 关闭内联面板；
        // 浏览页点「预览」时，通过 postMessage 让父窗口打开（embed/iframe 渲染）。
        ctx.effect(() => {
          const onMessage = (event) => {
            if (event.origin !== window.location.origin) return
            if (event.data && event.data.type === 'dsh-close-preview') {
              // 渲染页里的「关闭」：从列表进入的预览 → 回到文件列表；否则整面板退出。
              if (wsOverlay.history.length > 0) wsOverlay.back(); else wsOverlay.close()
            }
            if (event.data && event.data.type === 'dsh-open-preview' && typeof event.data.url === 'string') {
              wsOverlay.open(event.data.url, event.data.title || '文件', true)
            }
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        }, 'dsh-long-plugins: preview close message listener')
        const useOverlay = () => {
          const [state, setState] = React.useState({ url: wsOverlay.url, title: wsOverlay.title, canBack: wsOverlay.history.length > 0 })
          React.useEffect(() => wsOverlay.subscribe(() => setState({ url: wsOverlay.url, title: wsOverlay.title, canBack: wsOverlay.history.length > 0 })), [])
          return state
        }
        const WorkspaceFilesOverlay = () => {
          const { url, title, canBack } = useOverlay()
          const [maximized, setMaximized] = React.useState(false)
          // 预览某一文件时（history 非空）：「关闭」回到文件列表；否则整个面板退出。
          const closeOrBack = () => { if (canBack) wsOverlay.back(); else wsOverlay.close() }
          React.useEffect(() => {
            if (!url) return undefined
            const onKey = (event) => { if (event.key === 'Escape') { if (maximized) setMaximized(false); else closeOrBack() } }
            window.addEventListener('keydown', onKey)
            return () => window.removeEventListener('keydown', onKey)
          }, [url, maximized, canBack])
          if (!url) return null
          // inline 预览（PDF 原生查看器）：头部补 打开/下载；其它渲染页自带按钮。
          const isInline = url.indexOf('&inline=1') !== -1 || url.indexOf('?inline=1') !== -1
          return React.createElement('div', { className: 'dsh-ws-files-overlay' + (maximized ? ' dsh-ws-files-overlay-max' : '') },
            React.createElement('div', { className: 'dsh-ws-files-panel' },
              React.createElement('div', { className: 'dsh-ws-files-panel-head' },
                React.createElement('span', { className: 't' }, title || '工作区文件'),
                React.createElement('span', { className: 'sp' }),
                isInline && React.createElement('a', { className: 'dsh-ws-files-close', href: url, target: '_blank', rel: 'noopener noreferrer' }, '打开'),
                isInline && React.createElement('a', { className: 'dsh-ws-files-close', href: url.replace(/[?&]inline=1/, '') + (url.indexOf('?') !== -1 ? '&download=1' : '?download=1'), download: true }, '下载'),
                canBack && React.createElement('button', { type: 'button', className: 'dsh-ws-files-close', onClick: () => wsOverlay.back() }, '← 返回'),
                React.createElement('button', { type: 'button', className: 'dsh-ws-files-close', onClick: () => setMaximized((m) => !m) }, maximized ? '还原' : '放大'),
                React.createElement('button', { type: 'button', className: 'dsh-ws-files-close', onClick: closeOrBack }, '✕ 关闭'),
              ),
              isInline
                ? React.createElement('embed', { className: 'dsh-ws-files-frame', src: url, type: 'application/pdf', title: '文件预览' })
                : React.createElement('iframe', { className: 'dsh-ws-files-frame', src: url, title: '文件预览' }),
            ),
          )
        }
        const WorkspaceFilesButton = ({ sessionId, useSessions }) => {
          const cur = useSessions((s) => (sessionId === void 0 ? void 0 : s.byId[sessionId]?.cwd))
          React.useEffect(() => { if (cur) lastCwd = normPath(cur) }, [cur])
          // Windows 下 cwd 是反斜杠路径（C:\...\jacky），按 / 与 \ 都能切，取末段文件夹名。
          const ws = cur ? normPath(cur).split('/').filter(Boolean).pop() : ''
          return React.createElement(
            React.Fragment,
            null,
            React.createElement('button', {
              type: 'button',
              className: 'dsh-ws-files-btn',
              title: '工作区文件浏览' + (ws ? `（当前：${ws}，可切换总文件）` : '（所有工作区文件，可预览/下载）'),
              'aria-label': '工作区文件浏览',
              onClick: () => wsOverlay.open('/api/dsh-uploads/workspace-browse' + (ws ? `?ws=${encodeURIComponent(ws)}` : ''), `工作区文件${ws ? ` · ${ws}` : ''}`),
            },
              React.createElement('svg', {
                className: 'dsh-ws-files-icon',
                viewBox: '0 0 24 24',
                fill: 'currentColor',
                width: '14',
                height: '14',
                'aria-hidden': true,
              },
                React.createElement('path', { d: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z' }),
              ),
              React.createElement('span', { className: 'dsh-ws-files-label' }, '文件'),
            ),
            React.createElement(WorkspaceFilesOverlay, null),
          )
        }
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-workspace-files',
          order: 10,
          label: '文件',
        }, WorkspaceFilesButton))
      },
    }


    // ===== dsh-long-plugins: turn ruler (会话右侧轮次刻度，点击跳转提问) =====
    const TURN_RULER_CSS = `
      .dsh-turn-ruler{position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:1300;pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:14px;padding:14px 7px;border-radius:14px;background:color-mix(in srgb,var(--dsw-specific-input-major,#0f1720) 88%,transparent);border:1px solid var(--dsw-alias-border-l2,#2c3a47);box-shadow:var(--dsw-shadow-lv2);backdrop-filter:blur(6px)}
      .dsh-turn-ruler-dot{width:9px;height:9px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#2c3a47);background:var(--dsw-alias-bg-module-platform,#1a2530);cursor:pointer;padding:0;flex:none;transition:all .15s}
      .dsh-turn-ruler-dot:hover{transform:scale(1.45);border-color:var(--dsw-static-deepseek-500,#4d6bfe)}
      .dsh-turn-ruler-dot.active{background:var(--dsw-static-deepseek-500,#4d6bfe);border-color:var(--dsw-static-deepseek-500,#4d6bfe);transform:scale(1.3)}

      /* 轮次列表浮窗：每行一轮的提问摘要，滚轮选择刻度，点击定位会话 */
      .dsh-turn-preview{position:fixed;z-index:1300;pointer-events:auto;width:min(340px,46vw);height:min(420px,60vh);touch-action:none;overflow:hidden;display:flex;flex-direction:column;background:color-mix(in srgb,var(--dsw-specific-input-major,#0f1720) 97%,transparent);border:1px solid var(--dsw-alias-border-l2,#2c3a47);border-radius:12px;box-shadow:var(--dsw-shadow-lv3);backdrop-filter:blur(10px);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s}
      .dsh-turn-preview.open{opacity:1;visibility:visible}
      .dsh-turn-preview-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2c3a47);background:var(--dsw-alias-bg-module-platform,#141d27);flex:none}
      .dsh-turn-preview-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e5e7eb);flex:1}
      .dsh-turn-preview-count{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b98a5);flex:none;font-variant-numeric:tabular-nums}
      .dsh-turn-preview-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;padding:4px 0;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-label-tertiary,#8b98a5) transparent}
      .dsh-turn-preview-body::-webkit-scrollbar{width:4px}
      .dsh-turn-preview-body::-webkit-scrollbar-track{background:transparent}
      .dsh-turn-preview-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-label-tertiary,#8b98a5);border-radius:4px;min-height:24px}
      .dsh-turn-preview-row{display:flex;gap:8px;align-items:center;padding:6px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c2cad4);cursor:pointer;transition:background .15s ease,color .15s ease}
      /* 光标悬停 → 该行点亮（其他行不变） */
      .dsh-turn-preview-row:hover{background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover,#2c3a47) 80%,transparent);color:var(--dsw-alias-label-primary,#e5e7eb)}
      .dsh-turn-preview-row .n{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b98a5);font-variant-numeric:tabular-nums;width:18px;text-align:center}
      .dsh-turn-preview-row .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-turn-preview-close{flex:none;width:24px;height:24px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#2c3a47);background:transparent;color:var(--dsw-alias-label-secondary,#c2cad4);cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;font-size:13px;line-height:1;transition:all .15s}
      .dsh-turn-preview-close:hover{color:var(--dsw-alias-label-primary,#e5e7eb);border-color:var(--dsw-static-deepseek-500,#4d6bfe)}
      /* 手机/窄屏：右边缘竖向把手（半透明、不挡内容），点击打开预览窗 */
      .dsh-turn-phone-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:1300;pointer-events:auto;display:none;flex-direction:column;align-items:center;gap:10px;padding:14px 7px;border-radius:12px 0 0 12px;background:color-mix(in srgb,var(--dsw-specific-input-major,#0f1720) 82%,transparent);border:1px solid var(--dsw-alias-border-l2,#2c3a47);border-right:none;backdrop-filter:blur(6px);cursor:pointer;box-shadow:var(--dsw-shadow-lv2)}
      .dsh-turn-phone-tab-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8b98a5);flex:none;transition:all .2s}
      .dsh-turn-phone-tab:active{opacity:.7}
      .dsh-turn-preview-loading{display:flex;align-items:center;justify-content:center;padding:5px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b98a5);pointer-events:none}
      @media (max-width:1024px){
        .dsh-turn-ruler{display:none!important}
        .dsh-turn-phone-tab{display:flex}
        .dsh-turn-preview{width:min(360px,88vw);height:min(70vh,520px);top:50%!important;left:50%!important;transform:translate(-50%,-50%)!important}

      }
    `
    const turnRulerPlugin = {
      inject: [],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-long-plugins'
          style.dataset.pluginCss = 'dsh-long-plugins/turn-ruler'
          style.textContent = TURN_RULER_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-long-plugins: turn ruler styles')

        ctx.effect(() => {
          let ruler = null
          let preview = null
          let turns = []          // turns[i] = { userNode, summary }
          let scrollEl = null
          let observer = null
          let raf = 0
          let rendering = false
          let curIndex = -1
          let hideTimer = 0
          let touchActive = false
          let phoneTab = null
          let turnsPrevCount = -1
          let loadingOlder = false
          let scrollAnim = 0
          let scrollTarget = -1
          let scrollFrom = 0

          const ensureRuler = () => {
            if (ruler && ruler.isConnected) return ruler
            ruler = document.createElement('div')
            ruler.className = 'dsh-turn-ruler'
            ruler.setAttribute('aria-label', '轮次导航')
            document.body.appendChild(ruler)
            return ruler
          }

          const ensurePhoneTab = () => {
            if (phoneTab && phoneTab.isConnected) return phoneTab
            phoneTab = document.createElement('button')
            phoneTab.type = 'button'
            phoneTab.className = 'dsh-turn-phone-tab'
            phoneTab.setAttribute('aria-label', '轮次导航')
            for (let i = 0; i < 3; i++) {
              const d = document.createElement('span')
              d.className = 'dsh-turn-phone-tab-dot'
              phoneTab.appendChild(d)
            }
            document.body.appendChild(phoneTab)
            return phoneTab
          }

          const ensurePreview = () => {
            if (preview && preview.isConnected) return preview
            preview = document.createElement('div')
            preview.className = 'dsh-turn-preview'
            preview.innerHTML = '<div class="dsh-turn-preview-head"><span class="dsh-turn-preview-title">历史提问</span><span class="dsh-turn-preview-count"></span><button type="button" class="dsh-turn-preview-close" aria-label="关闭">✕</button></div><div class="dsh-turn-preview-body"></div>'
            document.body.appendChild(preview)
            return preview
          }

          const findScrollEl = (node) => {
            let el = node && node.parentElement
            while (el && el !== document.body) {
              const cs = getComputedStyle(el)
              if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return el
              el = el.parentElement
            }
            return null
          }

          const jumpTo = (node) => {
            if (!node || !node.isConnected) return
            const host = scrollEl
            if (host && host.isConnected) {
              const r = node.getBoundingClientRect()
              const sr = host.getBoundingClientRect()
              const targetTop = host.scrollTop + (r.top - sr.top) - 12
              try {
                host.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
              } catch {
                host.scrollTop = Math.max(0, targetTop)
              }
            } else {
              node.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          }

          // 提取一轮的摘要：取用户提问节点的文本（去图标/按钮文字）
          const summaryOf = (node) => {
            if (!node || !node.isConnected) return ''
            const bubble = node.querySelector('[class*="_bubble"]')
            let t = (bubble ? bubble.textContent : node.textContent || '').replace(/\s+/g, ' ').trim()
            t = t.replace(/(复制|下载|编辑|删除|预览|重试|点赞|点踩)$/i, '').trim()
            return t.slice(0, 120)
          }
          // 完整文本：用于搜索匹配（不截断）。优先取正文气泡（排除引用摘要/按钮杂讯），
          // 类名带 hash（gdEzaW_ 等），用 [class*="_bubble"] 通配；失败回退整个节点文本
          const fullTextOf = (node) => {
            if (!node || !node.isConnected) return ''
            const bubble = node.querySelector('[class*="_bubble"]')
            if (bubble) {
              const t = (bubble.textContent || '').replace(/\s+/g, ' ').trim()
              if (t) return t
            }
            return (node.textContent || '').replace(/\s+/g, ' ').trim()
          }

          // 主会话滚动：只更新 3 个刻度点的高亮。预览窗滚动位置 100% 由用户操作控制，
          // 绝不因主会话滚动/加载而移动（否则加载更早历史后焦点会跑到主会话位置）。
          const updateActive = () => {
            if (!scrollEl || turns.length === 0 || !ruler) return
            const viewTop = scrollEl.scrollTop
            let active = 0
            for (let i = 0; i < turns.length; i++) {
              const n = turns[i].userNode
              if (!n.isConnected) continue
              const r = n.getBoundingClientRect()
              const sr = scrollEl.getBoundingClientRect()
              const top = r.top - sr.top + scrollEl.scrollTop
              if (top <= viewTop + 90) active = i
            }
            // 3 个刻度点按当前轮次在总轮数中的位置高亮
            const ratio = turns.length <= 1 ? 0 : active / (turns.length - 1)
            const dotIdx = ratioToDot(ratio)
            const dots = ruler.querySelectorAll('.dsh-turn-ruler-dot')
            dots.forEach((d, i) => d.classList.toggle('active', i === dotIdx))
          }

          // 构建轮次：每个 user 节点一轮，摘要取该用户提问文本
          const buildTurns = () => {
            const result = []
            const users = document.querySelectorAll('[data-chat-flow-kind="user"]')
            users.forEach((node) => {
              const summary = summaryOf(node)
              if (summary) result.push({ userNode: node, summary, fullText: fullTextOf(node) })
            })
            return result
          }

          // 重建列表行（turns 集合变化时调用）
          // 焦点行 = 中心行：scrollTop=0 时第 0 行在焦点；scrollTop=(n-1)*rowH 时最后一行在焦点
          // 基于实际行 offsetTop 计算当前 scrollTop 对应的行（比估算行高精确）
          const focusIndex = () => {
            const body = preview && preview.querySelector('.dsh-turn-preview-body')
            if (!body) return 0
            const rows = body.querySelectorAll('.dsh-turn-preview-row')
            if (rows.length === 0) return 0
            const st = body.scrollTop
            for (let i = 0; i < rows.length; i++) {
              if (rows[i].offsetTop + rows[i].offsetHeight > st) return i
            }
            return rows.length - 1
          }
          const buildRows = () => {
            const el = ensurePreview()
            const body = el.querySelector('.dsh-turn-preview-body')
            // 重建前：停止动画；记录当前 scrollTop（用户操作的位置）
            cancelAnimationFrame(scrollAnim)
            scrollTarget = -1
            const scrollBefore = body ? body.scrollTop : 0
            body.innerHTML = ''
            turns.forEach((t, index) => {
              const row = document.createElement('div')
              row.className = 'dsh-turn-preview-row'
              row.dataset.index = String(index)
              const n = document.createElement('span')
              n.className = 'n'
              n.textContent = String(index + 1)
              const txt = document.createElement('span')
              txt.className = 't'
              txt.textContent = t.summary
              row.appendChild(n)
              row.appendChild(txt)
              body.appendChild(row)
            })
            el.querySelector('.dsh-turn-preview-count').textContent = `${turns.length} 轮`
            cachedRowH = -1
            rowHeightOf()
            // 列表上下加 padding：第一行和最后一行都能滚到中心焦点位
            applyFocusPadding()
            // 原则：预览窗位置只由用户操作控制。重建后保持原 scrollTop 完全不变
            // （加载更早历史 = 新行插在顶部，用户不操作，位置就不动；需要看新内容自己往上滚）
            if (body) {
              const max = Math.max(0, (turns.length - 1) * rowHeightOf())
              body.scrollTop = Math.max(0, Math.min(scrollBefore, max))
            }
            updateRowVisuals()
          }
          // 上下 padding = (视口高 - 行高)/2：首行 scrollTop=0 时中心恰在焦点线，末行同理
          const applyFocusPadding = () => {
            const body = preview && preview.querySelector('.dsh-turn-preview-body')
            if (!body) return
            const h = rowHeightOf()
            const pad = Math.max(0, (body.clientHeight - h) / 4)
            body.style.paddingTop = pad + 'px'
            body.style.paddingBottom = pad + 'px'
          }

          let cachedRowH = 30
          const rowHeightOf = () => {
            if (cachedRowH > 0) return cachedRowH
            if (!preview) return 30
            const first = preview.querySelector('.dsh-turn-preview-row')
            cachedRowH = first ? first.offsetHeight || 30 : 30
            return cachedRowH
          }

          // 视觉：active 行（点击切换的当前会话轮次）蓝色标记，其余不变


          // 列表滚动到某行到焦点位（无动画直接定位）
          const scrollListTo = (index) => {
            const body = preview && preview.querySelector('.dsh-turn-preview-body')
            if (!body) return
            const h = rowHeightOf()
            const max = Math.max(0, (turns.length - 1) * h)
            body.scrollTop = Math.max(0, Math.min(max, index * h))
          }

          // 选中某行：滚到该行真实 offsetTop + 直接高亮目标行（不依赖 scrollTop 反推，
          // 避免行高缓存偏差导致高亮错位）
          const selectRow = (index) => {
            if (turns.length === 0) return
            curIndex = Math.max(0, Math.min(turns.length - 1, index))
            const body = preview && preview.querySelector('.dsh-turn-preview-body')
            if (body) {
              const target = body.querySelector('.dsh-turn-preview-row[data-index="' + curIndex + '"]')
              if (target) {
                body.scrollTop = Math.max(0, target.offsetTop)
              }
            }
            updateRowVisuals(true)
          }

          // 高亮功能已移除：只维护 curIndex（供点击/滚动定位使用），不加任何 active 样式
          const updateRowVisuals = (explicitIndex) => {
            if (explicitIndex !== undefined) {
              curIndex = Math.max(0, Math.min((turns.length || 1) - 1, explicitIndex))
            } else if (preview) {
              const body = preview.querySelector('.dsh-turn-preview-body')
              const rows = preview.querySelectorAll('.dsh-turn-preview-row')
              const st = body ? body.scrollTop : 0
              curIndex = 0
              for (let i = 0; i < rows.length; i++) {
                if (rows[i].offsetTop + rows[i].offsetHeight > st) { curIndex = i; break }
              }
            }
          }

          const syncPreviewHighlight = (index) => {
            selectRow(index)
          }

          // 显示浮窗并选中 index：仅滚动浮窗列表到该行，主会话不跟随
          const showPreview = (index) => {
            const el = ensurePreview()
            if (turns.length === 0) { el.classList.remove('open'); return }
            el.classList.add('open')
            applyFocusPadding()
            selectRow(index)
            const pr = el.getBoundingClientRect()
            const rulerRect = ruler.getBoundingClientRect()
            const left = rulerRect.left - pr.width - 10
            let top = rulerRect.top + rulerRect.height / 2 - pr.height / 2
            top = Math.max(10, Math.min(top, window.innerHeight - pr.height - 10))
            el.style.left = Math.max(8, left) + 'px'
            el.style.top = top + 'px'
          }

          const hidePreview = () => {
            if (preview) preview.classList.remove('open')
          }

          // 按轮次比例计算三个刻度点的归属：0=最早 1=中间 2=最新
          const ratioToDot = (ratio) => {
            if (ratio < 0.34) return 0
            if (ratio < 0.67) return 1
            return 2
          }
          const buildRulerStatic = () => {
            const el = ensureRuler()
            el.innerHTML = ''
            for (let i = 0; i < 3; i++) {
              const dot = document.createElement('button')
              dot.type = 'button'
              dot.className = 'dsh-turn-ruler-dot'
              dot.dataset.dot = String(i)
              dot.setAttribute('aria-label', ['最早轮次', '中间轮次', '最新轮次'][i])
              el.appendChild(dot)
            }

          }
          const render = () => {
            if (rendering) return
            rendering = true
            try {
              const el = ensureRuler()
              const nextTurns = buildTurns()
              const countChanged = turns.length !== nextTurns.length
              turnsPrevCount = turns.length
              turns = nextTurns
              if (turns.length === 0) { el.style.display = 'none'; hidePreview(); return }
              el.style.display = 'flex'
              scrollEl = findScrollEl(turns[0].userNode) || scrollEl
              if (countChanged) {
                buildRulerStatic()
                buildRows()
              }
              updateActive()
            } finally {
              rendering = false
            }
          }

          const schedule = () => {
            cancelAnimationFrame(raf)
            raf = requestAnimationFrame(render)
          }

          // 事件委托：预览行点击 → 定位；3 刻度点 → 按比例定位；回到最后 → 滚到会话底部
          const onClick = (event) => {
            const t = event.target
            const closeBtn = t && t.closest ? t.closest('.dsh-turn-preview-close') : null
            if (closeBtn) {
              event.preventDefault()
              hidePreview()
              return
            }
            const row = t && t.closest ? t.closest('.dsh-turn-preview-row') : null
            if (row) {
              const index = Number(row.dataset.index)
              if (Number.isFinite(index) && turns[index]) {
                event.preventDefault()
                selectRow(index)
                jumpTo(turns[index].userNode)
                // 手机端：定位后关闭预览窗，方便看到会话跳转
                if (window.innerWidth <= 1024) hidePreview()
              }
              return
            }
            const tabBtn = t && t.closest ? t.closest('.dsh-turn-phone-tab') : null
            if (tabBtn) {
              event.preventDefault()
              const index = curIndex >= 0 ? curIndex : 0
              showPreview(index)
              return
            }
            const dot = t && t.closest ? t.closest('.dsh-turn-ruler-dot') : null
            if (dot) {
              event.preventDefault()
              if (turns.length === 0) return
              const dotIdx = Number(dot.dataset.dot)
              const ratio = [0, 0.5, 1][dotIdx] ?? 0
              const index = Math.round(ratio * (turns.length - 1))
              if (turns[index]) {
                selectRow(index)
                jumpTo(turns[index].userNode)
              }
            }
          }

          // 悬停刻度 → 打开浮窗并按比例选中对应轮次
          const onMouseOver = (event) => {
            const dot = event.target && event.target.closest
              ? event.target.closest('.dsh-turn-ruler-dot')
              : null
            if (dot && turns.length > 0) {
              const dotIdx = Number(dot.dataset.dot)
              const ratio = [0, 0.5, 1][dotIdx] ?? 0
              const index = Math.round(ratio * (turns.length - 1))
              showPreview(index)
            }
          }

          // 全局鼠标跟踪：进入刻度条/浮窗 → 取消延迟；移出两者 → 延迟 200ms 隐藏，
          // 保证鼠标从刻度条跨空白进入浮窗期间浮窗不消失。
          const onDocMouseOver = (event) => {
            const t = event.target
            const inRuler = t && t.closest ? t.closest('.dsh-turn-ruler') : null
            const inPreview = t && t.closest ? t.closest('.dsh-turn-preview') : null
            if (touchActive) return
            if (inRuler || inPreview) {
              if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
            } else if (!hideTimer) {
              hideTimer = setTimeout(() => { hideTimer = 0; hidePreview() }, 200)
            }
          }

          // 触摸滚动：预览窗 touch-action:none，手指滑动只驱动列表，页面不动
          let touchStartY = 0
          let touchBodyTop = 0
          const onPreviewTouchStart = (event) => {
            touchActive = true
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
            const body = preview && preview.querySelector('.dsh-turn-preview-body')
            if (!body || !preview.classList.contains('open') || !event.touches) return
            cancelAnimationFrame(scrollAnim)
            touchStartY = event.touches[0].clientY
            touchBodyTop = body.scrollTop
          }
          let touchFrame = 0
          const onPreviewTouchMove = (event) => {
            const body = preview && preview.querySelector('.dsh-turn-preview-body')
            if (!body || !preview.classList.contains('open') || !event.touches || turns.length === 0) return
            if (loadingOlder) return
            event.preventDefault()
            // 跟手滚动：只改 scrollTop（布局原生滚动，不触发视觉重算），避免每帧遍历卡顿
            const dy = touchStartY - event.touches[0].clientY
            const max = Math.max(0, (turns.length - 1) * rowHeightOf())
            body.scrollTop = Math.max(0, Math.min(max, touchBodyTop + dy))
            // rAF 节流更新视觉（每秒最多 ~60 次，且只 toggle 少量 class）
            if (!touchFrame) {
              touchFrame = requestAnimationFrame(() => {
                touchFrame = 0
                updateRowVisuals()
              })
            }
          }
          // 浮窗内滚轮 → 原生滚动列表浏览轮次标题；滚到顶部且主会话还有更早历史时自动加载
          let loadChain = 0
          const tryLoadOlder = () => {
            if (loadingOlder) return true
            cancelAnimationFrame(scrollAnim)
            scrollTarget = -1
            const flow = document.querySelector('[data-chat-flow]')
            const btn = flow && flow.querySelector('.Md3f7G_older button, [class*="_older"] button')
            if (!btn) return false
            if (btn.disabled) {
              // 正在加载：等待恢复后若仍接近顶部则继续加载下一页
              const chain = ++loadChain
              setTimeout(() => {
                if (chain === loadChain && preview && preview.classList.contains('open')) {
                  const body = preview.querySelector('.dsh-turn-preview-body')
                  if (body && body.scrollTop <= rowHeightOf() * 6) tryLoadOlder()
                }
              }, 120)
              return true
            }
            // 锁定：加载期间忽略新的滚动动画，避免与重建冲突
            loadingOlder = true
            // 列表顶部立即显示加载占位（消除等待期间的空白感）
            const pvBody = preview && preview.querySelector('.dsh-turn-preview-body')
            if (pvBody && !pvBody.querySelector('.dsh-turn-preview-loading')) {
              const ph = document.createElement('div')
              ph.className = 'dsh-turn-preview-loading'
              ph.textContent = '加载中…'
              pvBody.insertBefore(ph, pvBody.firstChild)
            }
            btn.click()
            // 等按钮先变 disabled（DSH 开始加载）再恢复可用（加载完成）后解锁
            let sawBusy = false
            const probe = () => {
              const b2 = document.querySelector('[data-chat-flow] [class*="_older"] button')
              if (b2) {
                if (b2.disabled) sawBusy = true
                else if (sawBusy) {
                  // 加载完成：延迟释放，让主会话加载后的滚动尘埃落定，避免覆盖预览焦点
                  setTimeout(() => { loadingOlder = false }, 100)
                  return
                }
              }
              setTimeout(probe, 15)
            }
            probe()
            return true
          }
          // 阻尼滚动 scrollTop（焦点固定、内容移动的 picker 手感）
          const dampedScrollTo = (target) => {
            const body = preview && preview.querySelector('.dsh-turn-preview-body')
            if (!body) return
            cancelAnimationFrame(scrollAnim)
            scrollFrom = body.scrollTop
            scrollTarget = Math.max(0, Math.min(target, Math.max(0, (turns.length - 1) * rowHeightOf())))
            if (Math.abs(scrollTarget - scrollFrom) < 0.5) { scrollTarget = -1; return }
            const step = () => {
              const body2 = preview && preview.querySelector('.dsh-turn-preview-body')
              if (!body2 || scrollTarget < 0) { scrollTarget = -1; return }
              const delta = (scrollTarget - body2.scrollTop) * 0.38
              if (Math.abs(delta) < 0.5) {
                body2.scrollTop = scrollTarget
                scrollTarget = -1
                updateRowVisuals()
                return
              }
              body2.scrollTop += delta
              updateRowVisuals()
              scrollAnim = requestAnimationFrame(step)
            }
            scrollAnim = requestAnimationFrame(step)
          }
          const onPreviewWheel = (event) => {
            if (!preview || !preview.classList.contains('open') || turns.length === 0) return
            event.preventDefault()
            const body = preview.querySelector('.dsh-turn-preview-body')
            if (!body) return
            // 加载更早历史期间锁定滚动，等重建完成后由锚点恢复焦点（避免震动）
            if (loadingOlder) return
            dampedScrollTo(body.scrollTop + event.deltaY * 0.5)
            // 接近顶部（1.5 行内）且继续向上滚 → 提前自动加载更早历史
            if (body.scrollTop <= rowHeightOf() * 6 && event.deltaY < 0) tryLoadOlder()
            // 已到列表顶部：尝试在主会话触发「加载更早」（按钮在 [data-chat-flow] 内、消息之前）
            if (body.scrollTop <= 2) tryLoadOlder()
          }
          // 触摸滚动后也检查顶部 → 自动加载
          const onPreviewTouchEnd = () => {
            // 触摸结束后短暂保持抑制，等合成的 mouse 事件过去
            setTimeout(() => { touchActive = false }, 300)
            const body = preview && preview.querySelector('.dsh-turn-preview-body')
            if (body && body.scrollTop <= rowHeightOf() * 6) tryLoadOlder()
          }
          // 列表 scroll 事件：仅用于滚到顶部自动加载（视觉不随滚动变化）
          const onBodyScroll = () => {
            if (rendering) return
            updateRowVisuals()
          }

          // 浮窗行 hover：纯 CSS 点亮，不滚动列表、不改变选中（滚动/切换仅通过滚动与点击）
          const onRowOver = () => {
            // no-op: hover styling handled entirely by CSS
          }

          observer = new MutationObserver((mutations) => {
            if (rendering) return
            const relevant = mutations.some((m) => {
              if (m.type !== 'childList') return false
              const t = m.target
              // 刻度条/浮窗自身的变更忽略（它们由我们维护，不反映会话变化）
              if (ruler && (t === ruler || ruler.contains(t))) return false
              if (preview && (t === preview || preview.contains(t))) return false
              // 其余任何 DOM 增删都可能带来新轮次（新消息常加在会话容器里，
              // target 不是 [data-chat-flow-kind] 后代，故不再做精确匹配）
              return true
            })
            if (relevant) schedule()
          })
          observer.observe(document.body, { childList: true, subtree: true })

          const root = ensureRuler()
          root.addEventListener('click', onClick)
          root.addEventListener('mouseover', onMouseOver)
          document.addEventListener('mouseover', onDocMouseOver)
          const pv = ensurePreview()
          pv.addEventListener('click', onClick)
          pv.addEventListener('wheel', onPreviewWheel, { passive: false })
          pv.addEventListener('touchstart', onPreviewTouchStart, { passive: true })
          pv.addEventListener('touchmove', onPreviewTouchMove, { passive: false })
          pv.addEventListener('touchend', onPreviewTouchEnd, { passive: true })
          pv.addEventListener('mouseover', onRowOver)
          const tab = ensurePhoneTab()
          tab.addEventListener('click', onClick)

          // 列表滚动（含惯性）时同步选中视觉
          const pvBody = pv.querySelector('.dsh-turn-preview-body')
          if (pvBody) pvBody.addEventListener('scroll', onBodyScroll, { passive: true })
          render()
          // 主会话滚动 → 同步刻度高亮；但加载更早历史期间及完成后短暂窗口内，
          // 不滚动预览窗（否则 DSH 加载后主会话自身滚动会覆盖用户焦点）
          const onSessionScroll = () => {
            if (loadingOlder) return
            updateActive()
          }
          if (scrollEl) scrollEl.addEventListener('scroll', onSessionScroll, { passive: true })
          window.addEventListener('resize', () => {
            cachedRowH = -1
            rowHeightOf()
            applyFocusPadding()
            updateActive()
            updateRowVisuals()
          })

          return () => {
            cancelAnimationFrame(raf)
            cancelAnimationFrame(scrollAnim)
            if (hideTimer) clearTimeout(hideTimer)
            if (observer) observer.disconnect()
            root.removeEventListener('click', onClick)
            root.removeEventListener('mouseover', onMouseOver)
            document.removeEventListener('mouseover', onDocMouseOver)
            pv.removeEventListener('click', onClick)
            pv.removeEventListener('wheel', onPreviewWheel)
            const _pvBody = pv.querySelector('.dsh-turn-preview-body')
            if (_pvBody) _pvBody.removeEventListener('scroll', onBodyScroll)
            pv.removeEventListener('touchstart', onPreviewTouchStart)
            pv.removeEventListener('touchmove', onPreviewTouchMove)
            pv.removeEventListener('touchend', onPreviewTouchEnd)
            pv.removeEventListener('mouseover', onRowOver)

            if (scrollEl) scrollEl.removeEventListener('scroll', onSessionScroll)
            window.removeEventListener('resize', updateActive)
            if (ruler) ruler.remove()
            if (phoneTab) phoneTab.remove()
            if (preview) preview.remove()
          }
        }, 'dsh-long-plugins: turn ruler')
      },
    }

    // ===== dsh-long-plugins: 毛玻璃界面 (glass UI) =====
    // 简洁方案：共用一张背景图铺满 body；左边栏 + 顶部各加一层半透明"罩"；
    // 会话窗口(centerCol)做成磨砂玻璃悬浮卡片(backdrop-filter blur + 半透明背景)。
    const GLASS_CSS = `
      html[data-dsh-glass="on"] body { position: relative; }
      /* 方案A：背景图铺满整页(含左栏/顶栏/底部，全透明透出)；仅会话滚动区做磨砂玻璃卡片。 */
      /* 左栏内部容器(或其它用此变量的)也透明，让背景图透到左栏。只覆盖左栏专用变量，避免影响设置面板。 */
      html[data-dsh-glass="on"] body {
        --dsw-specific-sidebar-fill: transparent !important;
      }
      /* 左栏 / 顶栏 / 底部：完全透明，让 frame 背景图连成一张透出（不做罩/不做磨砂） */
      html[data-dsh-glass="on"] #root [class*="sidebarCol"],
      html[data-dsh-glass="on"] #root [class*="wSkVaW_header"],
      html[data-dsh-glass="on"] #root [class*="centerCol"],
      html[data-dsh-glass="on"] #root [class*="wSkVaW_root"] {
        background-color: transparent !important;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      /* 左栏顶部「新会话」按钮：去掉白/黑实底与边框，透出背景图；文字颜色交由下方统一的侧边栏/顶栏可读文字规则决定 */
      html[data-dsh-glass="on"] #root [class*="newSession"] {
        background-color: transparent !important;
        background-image: none !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      /* 左栏/顶栏文字可读性改用 JS 处理(见 glassPlugin.apply 的 applyChromeText)，
         只作用于主界面左栏/顶栏、并跳过设置/弹窗/浮层，避免波及设置面板 */
      /* 左栏内部根 / 底部容器也用透明（这些是 DSH 当前版本哈希类名；背景图要透到左栏与底部） */
      html[data-dsh-glass="on"] #root [class*="hHd-Xa_root"],
      html[data-dsh-glass="on"] #root [class*="FJxK0a_root"] {
        background-color: transparent !important;
      }
      /* 会话滚动区：去掉独立磨砂卡片，直接透出共享背景（背景图+罩层颜色+模糊） */
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"] {
        background-color: transparent !important;
        background-image: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        overflow: auto;
        width: 100% !important;
        max-width: none !important;
        margin: 0 !important;
      }
      /* 背景图独立层：铺满整页、位于内容之下，可单独设背景图模糊与透明度，不影响内容清晰度 */
      .dsh-glass-bgimg{position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;display:none;}
      /* 滚动条：细、半透明、圆角，且左移贴在内容区（不占卡片最右边缘），让右边缘过渡柔和 */
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"]::-webkit-scrollbar { width: 8px; }
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"]::-webkit-scrollbar-track { background: transparent; }
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"]::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.35); border-radius: 8px; }
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"]::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.5); }
      /* 会话区禁用玻璃：scrollBody 还原为透明、无磨砂、无圆角/阴影（保持 DSH 原生会话区外观） */
      html[data-dsh-glass="on"][data-dsh-session-glass="off"] #root [class*="wSkVaW_scrollBody"] {
        background-color: transparent !important;
        background-image: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }
      /* 输入区外围(composerSeat/uV2eYG_root)透明，白块去掉、透出背景 */
      html[data-dsh-glass="on"] [class*="wSkVaW_composerSeat"],
      html[data-dsh-glass="on"] [class*="uV2eYG_root"] {
        background-color: transparent !important;
        background-image: none !important;
        box-shadow: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      /* 输入框盒子(uV2eYG_card)：实底(浅色=白/深色=深)并在背景图之上，文字随主题，保证可读。
         加 #root 提高优先级，压过 DSH 自身把 card 背景设透明的规则 */
      html[data-dsh-glass="on"] #root [class*="uV2eYG_card"],
      html[data-dsh-glass="on"] [class*="uV2eYG_card"] {
        position: relative !important;
        z-index: 0 !important;
        background-color: #ffffff !important;
        background-image: none !important;
        color: #1a2332 !important;
        box-shadow: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      @media (prefers-color-scheme: dark) {
        html[data-dsh-glass="on"] #root [class*="uV2eYG_card"],
        html[data-dsh-glass="on"] [class*="uV2eYG_card"] { background: #1c2530 !important; color: #f5f7fa !important; }
      }
      /* 轮次/历史提问预览：默认隐藏（点开才显示），并去掉头部底色，避免底部露出白条 */
      .dsh-turn-preview:not(.open){display:none !important;}
      .dsh-turn-preview-head{background:transparent !important;}
      
      html[data-dsh-glass="off"] #root [class*="sidebarCol"],
      html[data-dsh-glass="off"] #root [class*="header"],
      html[data-dsh-glass="off"] #root [class*="centerCol"],
      html[data-dsh-glass="off"] #root [class*="wSkVaW_root"],
      html[data-dsh-glass="off"] #root [class*="wSkVaW_scrollBody"] { background-color: transparent !important; backdrop-filter: none; }
      /* 会话消息气泡：半透明底(随主题, 60%透明=40%不透明)，与 AI 消息(透明/磨砂)区分、融入背景 */
      html[data-dsh-glass="on"] #root [class*="_bubble"]:not([class*="button"]) {
        background-color: color-mix(in srgb, var(--dsw-specific-input-major, #e8edf3) 40%, transparent) !important;
      }
      /* 统一桌面 + 浅色主题：DSH 的 secondary/tertiary 文字在浅色磨砂上太浅，统一加深，覆盖状态栏/工具标签等 */
      html[data-dsh-glass="on"][data-dsh-theme="light"] {
        --dsw-alias-label-secondary: #33414f !important;
        --dsw-alias-label-tertiary: #4a5866 !important;
      }
      /* 工具调用名(Bash/Shell等)与推理(think)标签：浅色下再显式压深，保证可读 */
      html[data-dsh-glass="on"][data-dsh-theme="light"] #root [class*="CY-8Ka_title"],
      html[data-dsh-glass="on"][data-dsh-theme="light"] #root [class*="QWLzLg_title"] {
        color: #2f3d4a !important;
      }
      /* 输入框下方状态/统计行(余额+步数/时长/速度等)都在 composer.dock 槽里：
         背景是会变的背景图, 单色难保证可读；给整块加半透明深色衬底+亮字, 任意背景都可读。
         槽位属性可能是 data-slot-conversation 或 data-slot(两种都锁) */
      html[data-dsh-glass="on"] [data-slot-conversation="conversation.composer.dock"],
      html[data-dsh-glass="on"] [data-slot="conversation.composer.dock"] {
        background-color: rgba(12,20,30,.55) !important;
        border-radius: 8px !important;
        padding: 1px 10px !important;
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
      }
      html[data-dsh-glass="on"] [data-slot-conversation="conversation.composer.dock"] *,
      html[data-dsh-glass="on"] [data-slot="conversation.composer.dock"] * {
        color: #f0f4f9 !important;
        text-shadow: 0 1px 2px rgba(0,0,0,.55);
      }
      /* 会话区所有内容元素背景透明化：去掉"反底色"小块衬底，统一融入磨砂卡片 */
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"] *:not([class*="button"]):not([class*="bubble"]):not([class*="_menu"]) {
        background-color: transparent !important;
      }
      /* 会话区内容衬底(代码块/提示/气泡/引用等)玻璃开启时透明化，融入磨砂卡片，去掉浅色小块衬底 */
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"] [class*="n_block"],
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"] [class*="n_bannerWrap"],

      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"] [class*="n_plain"],
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"] [class*="n_copyButton"],
      html[data-dsh-glass="on"] #root [class*="wSkVaW_scrollBody"] [class*="md-code-block"] {
        background-color: transparent !important;
      }
      /* 输入框下拉/悬浮菜单(如 / 命令、@ 提及)：背景给不透明随主题色，避免叠在会话磨砂卡上重叠看不清 */
      html[data-dsh-glass="on"] #root [class*="_menu"][class*="_menu"][class*="_menu"][class*="_menu"] {
        background-color: var(--dsw-specific-input-major, #e8edf3) !important;
        background-color: color-mix(in srgb, var(--dsw-specific-input-major, #e8edf3) 97%, transparent) !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      /* 输入框旁权限/功能选择下拉(盾牌 Full access 等 Radix 风格菜单)：与 / 命令菜单同样处理 */
      html[data-dsh-glass="on"] #root [class*="uV2eYG_card"] [class*="_root_"]:has([class*="_list_"]) {
        background-color: var(--dsw-specific-input-major, #e8edf3) !important;
        background-color: color-mix(in srgb, var(--dsw-specific-input-major, #e8edf3) 97%, transparent) !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      html[data-dsh-glass="on"] #root [class*="uV2eYG_card"] [class*="_list_"] {
        background-color: var(--dsw-specific-input-major, #e8edf3) !important;
        background-color: color-mix(in srgb, var(--dsw-specific-input-major, #e8edf3) 97%, transparent) !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      /* 玻璃开启 + 浅色系统主题：加深弱化标签/元信息文字，避免浅灰字叠在浅磨砂卡上看不清 */
      @media (prefers-color-scheme: light) {
        html[data-dsh-glass="on"],
        html[data-dsh-glass="on"] * {
          --dsw-alias-label-secondary: #383d44 !important;
          --dsw-alias-label-tertiary: #50545b !important;
        }
      }
      .dsh-glass-section{display:flex;flex-direction:column;gap:16px;min-width:0;padding:4px 2px 24px;color:var(--dsw-alias-label-primary)}
      .dsh-glass-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
      .dsh-glass-head h2{margin:0;font-size:20px;line-height:28px}
      .dsh-glass-head p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      .dsh-glass-switch{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;user-select:none}
      .dsh-glass-switch input{width:34px;height:20px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
      .dsh-glass-card{display:grid;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-input-major)}
      .dsh-glass-zone-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
      .dsh-glass-input-theme{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:12px;display:grid;gap:12px}
      .dsh-glass-input-theme:first-of-type{border-top:none;padding-top:0}
      .dsh-glass-theme-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
      .dsh-glass-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .dsh-glass-row label{font-size:13px;color:var(--dsw-alias-label-primary);flex:none}
      .dsh-glass-range{flex:1;min-width:160px;max-width:320px;accent-color:var(--dsw-alias-state-business-primary)}
      .dsh-glass-val{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
      .dsh-glass-swatches{display:flex;gap:8px;flex-wrap:wrap}
      .dsh-glass-swatch{width:26px;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;padding:0;transition:transform .12s}
      .dsh-glass-swatch:hover{transform:scale(1.12)}
      .dsh-glass-swatch.on{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .dsh-glass-colorpicker{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;cursor:pointer}
      .dsh-glass-colorpicker input[type=color]{width:30px;height:24px;border:none;background:none;padding:0;cursor:pointer}
      .dsh-glass-bg{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .dsh-glass-file{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
      .dsh-glass-file input{display:none}
      .dsh-glass-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}
      .dsh-glass-actions button{padding:7px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
      .dsh-glass-actions .primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}
      .dsh-glass-actions button:disabled{opacity:.55;cursor:not-allowed}
      .dsh-glass-error{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}
      .dsh-glass-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
    `
    const GLASS_SWATCHES = ['#1a2332', '#0f1420', '#1e3a5f', '#1e5e46', '#5e2e5e', '#6e2323']
    const glassText = (e) => (e && e.message) ? e.message : String(e)
    function glassImageInput(value, onChange) {
      return React.createElement('label', { className: 'dsh-glass-file' },
        React.createElement('span', null, '上传背景图'),
        React.createElement('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', onChange: (e) => {
          const f = e.target.files && e.target.files[0]
          if (!f) return
          const reader = new FileReader()
          reader.onload = () => onChange(String(reader.result || ''))
          reader.readAsDataURL(f)
        } }),
        value ? React.createElement('span', { style: { width: 22, height: 22, borderRadius: 4, backgroundImage: 'url(' + value + ')', backgroundSize: 'cover', display: 'inline-block' } }) : null,
      )
    }
    // 会话区/输入区共用设置卡：罩色 + 罩强度
    const GlassZoneCard = ({ title, zone, onChange, showGlassToggle }) => {
      const z = zone || { color: '#1a2332', mask: 0.45, enabled: true }
      const setPatch = (p) => onChange({ ...z, ...p })
      return React.createElement('div', { className: 'dsh-glass-card' },
        React.createElement('div', { className: 'dsh-glass-zone-title' }, title),
        showGlassToggle ? React.createElement('div', { className: 'dsh-glass-row' },
          React.createElement('label', { className: 'dsh-glass-switch' }, React.createElement('input', { type: 'checkbox', checked: z.enabled !== false, onChange: (e) => setPatch({ enabled: e.target.checked }) }), title + ' 启用玻璃'),
        ) : null,
        React.createElement('div', { className: 'dsh-glass-row' },
          React.createElement('label', null, title + ' 罩色'),
          React.createElement('div', { className: 'dsh-glass-swatches' },
            GLASS_SWATCHES.map((c) => React.createElement('button', { key: c, type: 'button', className: 'dsh-glass-swatch' + ((z.color || '#1a2332') === c ? ' on' : ''), style: { background: c }, 'aria-label': '颜色 ' + c, onClick: () => setPatch({ color: c }) })),
          ),
          React.createElement('label', { className: 'dsh-glass-colorpicker' }, '色盘', React.createElement('input', { type: 'color', value: z.color || '#1a2332', onChange: (e) => setPatch({ color: e.target.value }) })),
        ),
        React.createElement('div', { className: 'dsh-glass-row' },
          React.createElement('label', null, title + ' 罩强度'),
          React.createElement('input', { type: 'range', className: 'dsh-glass-range', min: 0, max: 0.95, step: 0.01, value: z.mask ?? 0.45, onChange: (e) => setPatch({ mask: Number(e.target.value) }) }),
          React.createElement('span', { className: 'dsh-glass-val' }, `${Math.round((Number(z.mask ?? 0.45)) * 100)}%`),
        ),
        React.createElement('div', { className: 'dsh-glass-row' },
          React.createElement('label', null, title + ' 透明度'),
          React.createElement('input', { type: 'range', className: 'dsh-glass-range', min: 0, max: 1, step: 0.01, value: z.opacity ?? 0.5, onChange: (e) => setPatch({ opacity: Number(e.target.value) }) }),
          React.createElement('span', { className: 'dsh-glass-val' }, `${Math.round((Number(z.opacity ?? 0.5)) * 100)}%`),
        ),
      )
    }
    const GlassSettingsSection = () => {
      const [state, setState] = React.useState({ loading: true, saving: false, error: '', cfg: null, bgImage: '' })
      const load = React.useCallback(async () => {
        setState((s) => ({ ...s, loading: true, error: '' }))
        try {
          const r = await fetch('/api/dsh-uploads/glass-config', { cache: 'no-store' })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status))
          setState((s) => ({ ...s, loading: false, cfg: b.cfg, bgImage: b.bgImage || '' }))
        } catch (e) { setState((s) => ({ ...s, loading: false, error: glassText(e) })) }
      }, [])
      React.useEffect(() => { load(); }, [load])
      const patch = React.useCallback((p) => setState((s) => ({ ...s, cfg: { ...(s.cfg || {}), ...p } })), [])
      const patchZone = React.useCallback((key, p) => setState((s) => ({ ...s, cfg: { ...(s.cfg || {}), [key]: p } })), [])
      // 输入框设置：按主题(theme)合并进 cfg.inputBox[theme]（不整体覆盖、不丢另一主题）
      const patchInput = React.useCallback((theme, p) => setState((s) => {
        const box = { light: { color: '', opacity: 1 }, dark: { color: '', opacity: 1 }, ...((s.cfg && s.cfg.inputBox) || {}) }
        box[theme] = { ...((box[theme]) || { color: '', opacity: 1 }), ...p }
        return { ...s, cfg: { ...(s.cfg || {}), inputBox: box } }
      }), [])
      // 背景罩设置：按主题合并进 cfg.bgTint[theme]
      const patchBgTint = React.useCallback((theme, p) => setState((s) => {
        const box = { light: { color: '#1a2332', mask: 0.28 }, dark: { color: '#1a2332', mask: 0.28 }, ...((s.cfg && s.cfg.bgTint) || {}) }
        box[theme] = { ...((box[theme]) || { color: '#1a2332', mask: 0.28 }), ...p }
        return { ...s, cfg: { ...(s.cfg || {}), bgTint: box } }
      }), [])
      const save = React.useCallback(async () => {
        setState((s) => ({ ...s, saving: true, error: '' }))
        try {
          const cfg = state.cfg || {}
          const num = (v, fb) => ((typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : fb)
          const payload = {
            enabled: !!cfg.enabled, blur: num(cfg.blur, 0),
            bgImage: state.bgImage || cfg.bgImage || '', bgMask: num(cfg.bgMask, 0.28), bgColor: cfg.bgColor || '#1a2332', bgBlur: num(cfg.bgBlur, 0), bgOpacity: num(cfg.bgOpacity, 1),
            bgTint: {
              light: { color: (cfg.bgTint?.light?.color) || '#1a2332', mask: num(cfg.bgTint?.light?.mask, 0.28) },
              dark: { color: (cfg.bgTint?.dark?.color) || '#1a2332', mask: num(cfg.bgTint?.dark?.mask, 0.28) },
            },
            inputBox: {
              light: { color: (cfg.inputBox?.light?.color) || '', opacity: num(cfg.inputBox?.light?.opacity, 1) },
              dark: { color: (cfg.inputBox?.dark?.color) || '', opacity: num(cfg.inputBox?.dark?.opacity, 1) },
            },
            zone: {
              session: { enabled: cfg.session && cfg.session.enabled !== false, color: (cfg.session && cfg.session.color) || '#1a2332', mask: num(cfg.session && cfg.session.mask, 0.45), opacity: num(cfg.session && cfg.session.opacity, 0.5) },
              input: { color: (cfg.input && cfg.input.color) || '#1a2332', mask: num(cfg.input && cfg.input.mask, 0.6), opacity: num(cfg.input && cfg.input.opacity, 0.55) },
            },
          }
          const r = await fetch('/api/dsh-uploads/glass-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status))
          window.__dshGlassApply && window.__dshGlassApply(payload)
          setState((s) => ({ ...s, saving: false, cfg: { ...(s.cfg || {}), ...payload }, bgImage: payload.bgImage, error: '' }))
        } catch (e) { setState((s) => ({ ...s, saving: false, error: glassText(e) })) }
      }, [state])
      const cfg = state.cfg || {}
      if (state.loading) return React.createElement('div', { className: 'dsh-glass-section' }, '加载中…')
      return React.createElement('div', { className: 'dsh-glass-section' },
        React.createElement('div', { className: 'dsh-glass-head' },
          React.createElement('div', null, React.createElement('h2', null, 'RA-Span'), React.createElement('p', null, '共用一张背景图铺满整页（RA-Span）：背景图、背景罩层颜色、背景模糊/透明度可调；会话区/输入区按需透明或实底。')),
          React.createElement('label', { className: 'dsh-glass-switch' }, React.createElement('input', { type: 'checkbox', checked: !!cfg.enabled, onChange: (e) => patch({ enabled: e.target.checked }) }), cfg.enabled ? '已开启' : '已关闭'),
        ),
        state.error ? React.createElement('div', { className: 'dsh-glass-error' }, state.error) : null,
        React.createElement('div', { className: 'dsh-glass-card' },
          React.createElement('div', { className: 'dsh-glass-row' },
            React.createElement('label', null, '磨砂模糊强度'),
            React.createElement('input', { type: 'range', className: 'dsh-glass-range', min: 0, max: 80, value: cfg.blur ?? 20, onChange: (e) => patch({ blur: Number(e.target.value) }) }),
            React.createElement('span', { className: 'dsh-glass-val' }, `${Number(cfg.blur ?? 20)} px`),
          ),
          React.createElement('div', { className: 'dsh-glass-row' },
            React.createElement('label', null, '共用背景图'),
            React.createElement('div', { className: 'dsh-glass-bg' }, glassImageInput(state.bgImage, (v) => setState((s) => ({ ...s, bgImage: v })))),
          ),
          React.createElement('div', { className: 'dsh-glass-card' },
            React.createElement('div', { className: 'dsh-glass-zone-title' }, '背景罩'),
            [['light', '浅色主题', '#1a2332'], ['dark', '深色主题', '#1a2332']].map(([t, label, native]) => {
              const bt = (cfg.bgTint && cfg.bgTint[t]) || { color: native, mask: 0.28 }
              return React.createElement('div', { key: t, className: 'dsh-glass-input-theme' },
                React.createElement('div', { className: 'dsh-glass-theme-label' }, label),
                React.createElement('div', { className: 'dsh-glass-row' },
                  React.createElement('label', null, '罩色'),
                  React.createElement('label', { className: 'dsh-glass-colorpicker' }, '色盘', React.createElement('input', { type: 'color', value: bt.color || native, onChange: (e) => patchBgTint(t, { color: e.target.value }) })),
                ),
                React.createElement('div', { className: 'dsh-glass-row' },
                  React.createElement('label', null, '罩强度'),
                  React.createElement('input', { type: 'range', className: 'dsh-glass-range', min: 0, max: 0.95, step: 0.01, value: (typeof bt.mask === 'number') ? bt.mask : 0.28, onChange: (e) => patchBgTint(t, { mask: Number(e.target.value) }) }),
                  React.createElement('span', { className: 'dsh-glass-val' }, `${Math.round((typeof bt.mask === 'number' ? bt.mask : 0.28) * 100)}%`),
                ),
              )
            }),
            React.createElement('p', { className: 'dsh-glass-note' }, '浅色主题与深色主题可分别设置背景罩颜色与罩强度，切换主题时自动应用对应的一套。'),
          ),
          React.createElement('div', { className: 'dsh-glass-row' },
            React.createElement('label', null, '背景图模糊'),
            React.createElement('input', { type: 'range', className: 'dsh-glass-range', min: 0, max: 60, value: cfg.bgBlur ?? 0, onChange: (e) => patch({ bgBlur: Number(e.target.value) }) }),
            React.createElement('span', { className: 'dsh-glass-val' }, `${Number(cfg.bgBlur ?? 0)} px`),
          ),
          React.createElement('div', { className: 'dsh-glass-row' },
            React.createElement('label', null, '背景图透明度'),
            React.createElement('input', { type: 'range', className: 'dsh-glass-range', min: 0, max: 1, step: 0.01, value: cfg.bgOpacity ?? 1, onChange: (e) => patch({ bgOpacity: Number(e.target.value) }) }),
            React.createElement('span', { className: 'dsh-glass-val' }, `${Math.round((Number(cfg.bgOpacity ?? 1)) * 100)}%`),
          ),
          React.createElement('div', { className: 'dsh-glass-card' },
            React.createElement('div', { className: 'dsh-glass-zone-title' }, '输入框'),
            [['light', '浅色主题', '#ffffff'], ['dark', '深色主题', '#1c2530']].map(([t, label, native]) => {
              const tb = (cfg.inputBox && cfg.inputBox[t]) || { color: '', opacity: 1 }
              return React.createElement('div', { key: t, className: 'dsh-glass-input-theme' },
                React.createElement('div', { className: 'dsh-glass-theme-label' }, label),
                React.createElement('div', { className: 'dsh-glass-row' },
                  React.createElement('label', null, '输入框颜色'),
                  React.createElement('label', { className: 'dsh-glass-colorpicker' }, '色盘', React.createElement('input', { type: 'color', value: tb.color || native, onChange: (e) => patchInput(t, { color: e.target.value }) })),
                  React.createElement('button', { type: 'button', style: { marginLeft: 8, fontSize: 12 }, onClick: () => patchInput(t, { color: '', opacity: 1 }) }, '原生'),
                ),
                React.createElement('div', { className: 'dsh-glass-row' },
                  React.createElement('label', null, '不透明度'),
                  React.createElement('input', { type: 'range', className: 'dsh-glass-range', min: 0, max: 1, step: 0.01, value: (typeof tb.opacity === 'number') ? tb.opacity : 1, onChange: (e) => patchInput(t, { opacity: Number(e.target.value) }) }),
                  React.createElement('span', { className: 'dsh-glass-val' }, `${Math.round((typeof tb.opacity === 'number' ? tb.opacity : 1) * 100)}%`),
                ),
              )
            }),
            React.createElement('p', { className: 'dsh-glass-note' }, '浅色主题与深色主题可分别设置。100% = 实底不透明，越低越透出背景图；"原生" = 跟随该主题的 DSH 原生色。文字颜色按背景亮度自动配深/浅，保证可读。'),
          ),
          React.createElement('p', { className: 'dsh-glass-note' }, '提示：背景图铺满整页(可加背景图罩)；背景图模糊/透明度单独可调；会话区使用自己的罩色、罩强度与透明度；左栏/顶部透出背景图；输入框颜色/不透明度可单独设置。'),
          React.createElement('div', { className: 'dsh-glass-actions' },
            React.createElement('button', { type: 'button', onClick: load }, '重置'),
            React.createElement('button', { type: 'button', className: 'primary', disabled: state.saving, onClick: save }, state.saving ? '保存中…' : '保存生效'),
          ),
        ),
      )
    }
    const glassPlugin = {
      inject: ['slots'],
      apply(ctx) {
        const hexToRgb = (hex) => { const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '')); return m ? `${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)}` : '15,20,32' }
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-long-plugins'
          style.dataset.pluginCss = 'dsh-long-plugins/glass'
          style.textContent = GLASS_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-long-plugins: glass styles')
        ctx.effect(() => {
          const root = document.documentElement
          
          // 磨砂卡片与底部输入卡片对齐：宽度取输入卡片宽度，translateX 补偿使左右边界对齐输入卡。
          const centerScroll = () => {
            const el = document.querySelector('#root [class*="wSkVaW_scrollBody"]')
            if (!el) return
            const card = document.querySelector('#root [class*="uV2eYG_card"]')
            const r = el.getBoundingClientRect()
            const target = card ? card.getBoundingClientRect() : null
            // 不改磨砂卡片宽度（保留默认 width:min() 原始宽度），仅水平居中到输入卡片中心。
            const diff = (target ? (target.left + target.right) / 2 : window.innerWidth / 2) - (r.left + r.right) / 2
            el.style.transform = 'translateX(' + Math.round(diff) + 'px)'
          }
          window.addEventListener('resize', centerScroll)
          window.__dshGlassCenter = centerScroll
          // 主题切换监听：观察 <html> 的 style/class；只创建一次（自触发的写入在 applyTheme 内先断开再重连，杜绝死循环）
          window.__dshGlassStyleObs = null
          if (!window.__dshGlassStyleObs) {
            window.__dshGlassStyleObs = new MutationObserver(() => window.__dshGlassApplyTheme && window.__dshGlassApplyTheme())
            window.__dshGlassStyleObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
          }
          const themeMq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)')
          const themeMqHandler = () => window.__dshGlassApplyTheme && window.__dshGlassApplyTheme()
          if (themeMq) themeMq.addEventListener('change', themeMqHandler)
          // win 风格文字：给左栏/顶栏内的可见文字元素加白色+深色描边；跳过弹窗(modal/overlay/dialog/settings/panel)内元素。

          window.__dshGlassApply = (cfg) => {
            const c = cfg || {}
            // 手机端/窄屏(<=768px)：不开启毛玻璃，还原 DSH 原生样式（清背景图/罩变量/磨砂）。
            if (window.innerWidth <= 768) {
              root.setAttribute('data-dsh-glass', 'off')
              root.setAttribute('data-dsh-session-glass', 'off')
              root.style.setProperty('--dsh-glass-blur', '')
              root.style.setProperty('--dsh-glass-session-bg', '')
              root.style.setProperty('--dsh-glass-input-bg', '')
              root.style.setProperty('--dsh-glass-bg-zone', '')
              const b = document.body
              b.style.backgroundImage = 'none'; b.style.backgroundSize = ''; b.style.backgroundPosition = ''; b.style.backgroundRepeat = ''
              const fr = document.querySelector('#root > div > div') || document.querySelector('#root > div')
              if (fr) { fr.style.backgroundColor = ''; fr.style.backgroundImage = 'none'; fr.style.backgroundSize = ''; fr.style.backgroundPosition = ''; fr.style.backgroundRepeat = '' }
              const bgEl = document.querySelector('.dsh-glass-bgimg'); if (bgEl) { bgEl.style.display = 'none' }
              return
            }
            // 读 DSH 真实主题（DSH 用 inline `color-scheme` 写在 <html style> 上，非 OS 偏好）
            const dshDark = () => /dark/i.test(getComputedStyle(document.documentElement).colorScheme)
            // 颜色亮度(0~1)：用来自动决定文字用深色还是浅色，保证可读
            const relLum = (hex) => {
              const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''))
              if (!m) return 0.5
              const map = (v) => { const s = parseInt(v, 16) / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
              return 0.2126 * map(m[1]) + 0.7152 * map(m[2]) + 0.0722 * map(m[3])
            }
            root.setAttribute('data-dsh-glass', c.enabled ? 'on' : 'off')
            const sessOn = !(c.zone && c.zone.session && c.zone.session.enabled === false)
            root.setAttribute('data-dsh-session-glass', sessOn ? 'on' : 'off')
            const blurn = Number(c.blur); const blur = Math.max(0, Math.min(80, Number.isFinite(blurn) ? blurn : 16))
            root.style.setProperty('--dsh-glass-blur', blur + 'px')
            const zs = (c.zone && c.zone.session) || { color: '#1a2332', mask: 0.45, opacity: 0.5 }
            const zi = (c.zone && c.zone.input) || { color: '#1a2332', mask: 0.6, opacity: 0.55 }
            const smn = Number(zs.mask); const sm = Math.min(0.95, Math.max(0, Number.isFinite(smn) ? smn : 0.45))
            root.style.setProperty('--dsh-glass-session-bg', `rgba(${hexToRgb(zs.color)},${sm})`)
            const imn = Number(zi.mask); const im = Math.min(0.95, Math.max(0, Number.isFinite(imn) ? imn : 0.6))
            root.style.setProperty('--dsh-glass-input-bg', `rgba(${hexToRgb(zi.color)},${im})`)
            // 透明度=透明程度：越大越透明（100%=>雾面无填充,完全透出背景）
            const sop = Math.min(1, Math.max(0, Number.isFinite(Number(zs.opacity)) ? Number(zs.opacity) : 0.5))
            root.style.setProperty('--dsh-glass-session-white', `color-mix(in srgb, var(--dsw-specific-input-major, #e8edf3) ${Math.round((1 - sop) * 100)}%, transparent)`)
            const iop = Math.min(1, Math.max(0, Number.isFinite(Number(zi.opacity)) ? Number(zi.opacity) : 0.55))
            root.style.setProperty('--dsh-glass-input-white', `color-mix(in srgb, var(--dsw-specific-input-major, #e8edf3) ${Math.round((1 - iop) * 100)}%, transparent)`)

            // 背景图罩（整页背景图上叠一层半透明罩色）：浅/深主题各一套 color+mask；
            // 兼容旧版单套 bgColor/bgMask。
            const bgTint = (tk) => {
              const t = (c.bgTint && c.bgTint[tk]) || { color: c.bgColor || '#1a2332', mask: c.bgMask ?? 0.28 }
              const mask = Math.min(0.95, Math.max(0, Number.isFinite(Number(t && t.mask)) ? Number(t.mask) : 0.28))
              return { color: (t && t.color) || '#1a2332', mask }
            }
            // 给输入框卡片设内联实底+文字色，且用 !important，
            // 因为 DSH 核心样式用 background-color: transparent !important 压过普通内联样式；
            // 内联 !important 优先级最高，一定覆盖。颜色/不透明度来自配置 inputBox。
            const applyInputCard = () => {
              const inputCard = document.querySelector('#root [class*="uV2eYG_card"]')
              if (!inputCard) return
              const dark = dshDark()
              const ib = (c.inputBox && typeof c.inputBox === 'object') ? c.inputBox : {}
              // 浅色/深色各一套配置；兼容旧版单套 inputBox:{color,opacity}
              const tb = (ib.light && ib.dark) ? (dark ? ib.dark : ib.light) : ib
              const defBg = dark ? '#1c2530' : '#ffffff'
              // color: 空串/非法 => 用主题原生色；否则用用户指定的颜色
              const hasColor = tb && typeof tb.color === 'string' && /^#/.test(tb.color)
              const bgHex = hasColor ? tb.color : defBg
              const alpha = (tb && typeof tb.opacity === 'number' && Number.isFinite(tb.opacity)) ? Math.min(1, Math.max(0, tb.opacity)) : 1
              const bg = `rgba(${hexToRgb(bgHex)},${alpha})`
              const fg = relLum(bgHex) > 0.5 ? '#1a2332' : '#f5f7fa'
              inputCard.style.setProperty('background-color', bg, 'important')
              inputCard.style.setProperty('color', fg, 'important')
              // 子层(scroll/row)也是透明的，继承卡片文字色即可，确保可读
              inputCard.querySelectorAll('[class*="uV2eYG_scroll"],[class*="uV2eYG_row"]').forEach(el => {
                el.style.setProperty('color', fg, 'important')
              })
            }
            // 主界面左栏/顶栏可见文字：白字+单层轻投影(Windows 桌面图标风格, 不加粗)。
            // 显式跳过设置/弹窗/浮层(modal/overlay/dialog/settings/panel/drawer/Radix/menu), 避免波及设置面板/弹出菜单。
            const SKIP_SEL = ':is([class*="settings"],[class*="Dialog"],[class*="dialog"],[class*="modal"],[class*="overlay"],[class*="_panel"],[class*="panel"],[class*="drawer"],[class*="Radix"],[class*="_menu"])'
            const isInSkip = (el) => { let p = el; while (p && p !== document.documentElement) { if (p.matches && p.matches(SKIP_SEL)) return true; p = p.parentElement } return false }
            const applyChromeText = () => {
              if (!c.enabled) return
              // 只处理主界面左栏/顶栏内带文字的元素；跳过图标/纯容器。
              // 文字检测放宽：button/a/span/li/p/标题等直接算，纯 div 容器需自身带文本才算，
              // 这样底部「设置/已归档」等包在子元素里的按钮也能命中。
              const roots = [...document.querySelectorAll('#root [class*="sidebarCol"],#root [class*="wSkVaW_header"]')]
              roots.forEach((root) => {
                if (isInSkip(root)) return
                root.querySelectorAll('div,span,button,a,label,p,li,h1,h2,h3,h4').forEach((el) => {
                  if (isInSkip(el)) return
                  const tag = el.tagName
                  const hasText = el.textContent && el.textContent.trim()
                  if (!hasText) return
                  const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())
                  const textLike = /^(BUTTON|A|SPAN|LABEL|LI|P|H1|H2|H3|H4)$/.test(tag)
                  if (!textLike && !ownText) return
                  el.style.setProperty('color', '#ffffff', 'important')
                  el.style.setProperty('text-shadow', '0 1px 2px rgba(0,0,0,.85)')
                })
                // 图标也变白(随 currentColor)，用于工作区文件夹等单色图标；保留显式品牌色
                root.querySelectorAll('svg, [class*="icon"], [class*="Icon"]').forEach((el) => {
                  if (isInSkip(el)) return
                  el.style.setProperty('color', '#ffffff', 'important')
                  el.querySelectorAll('path,use,rect,circle,line,polyline,ellipse').forEach((p) => {
                    const f = (p.getAttribute('fill') || '').toLowerCase()
                    if (f && f !== 'none' && f !== 'currentcolor') return
                    p.style.setProperty('fill', 'currentColor', 'important')
                    const s = (p.getAttribute('stroke') || '').toLowerCase()
                    if (s && s !== 'none' && s !== 'currentcolor') return
                    p.style.setProperty('stroke', 'currentColor', 'important')
                  })
                })
              })
            }
            // 主题相关的东西统一重算：背景罩 + 输入框。切主题时由 observer/mq 触发。
            // 写入前先断开观察器，写完再重连，避免自触发造成死循环。
            const applyTheme = () => {
              const obs = window.__dshGlassStyleObs
              if (obs) obs.disconnect()
              try {
                const tk = dshDark() ? 'dark' : 'light'
                root.setAttribute('data-dsh-theme', tk)
                const bt = bgTint(tk)
                const v = `rgba(${hexToRgb(bt.color)},${bt.mask})`
                root.style.setProperty('--dsh-glass-bg-zone', v)
                applyInputCard()
                applyChromeText()
              } finally {
                if (obs) obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
              }
            }

            const body = document.body
            const frame = document.querySelector('#root > div > div') || document.querySelector('#root > div')
            // 背景图独立层：铺满整页、位于内容之下；背景图模糊/透明度单独可调（不影响内容清晰度）。
            // 背景罩用 CSS 变量 var(--dsh-glass-bg-zone)，随主题切换自动刷新。
            let bgimg = document.querySelector('.dsh-glass-bgimg')
            if (!bgimg) { bgimg = document.createElement('div'); bgimg.className = 'dsh-glass-bgimg'; document.body.appendChild(bgimg) }
            const gzv = root.style.getPropertyValue('--dsh-glass-bg-zone') || 'rgba(26,35,50,0.28)'
            if (c.enabled && c.bgImage) {
              bgimg.style.display = 'block'
              bgimg.style.backgroundImage = `linear-gradient(var(--dsh-glass-bg-zone, ${gzv}), var(--dsh-glass-bg-zone, ${gzv})), url('${c.bgImage}')`
              bgimg.style.backgroundSize = 'cover'
              bgimg.style.backgroundPosition = 'center'
              bgimg.style.backgroundRepeat = 'no-repeat'
              const bblur = Math.max(0, Math.min(80, Number.isFinite(Number(c.bgBlur)) ? Number(c.bgBlur) : 0))
              bgimg.style.filter = bblur > 0 ? `blur(${bblur}px)` : 'none'
              const bop = Math.max(0, Math.min(1, Number.isFinite(Number(c.bgOpacity)) ? Number(c.bgOpacity) : 1))
              bgimg.style.opacity = String(bop)
            } else {
              bgimg.style.display = 'none'
            }
            // 移除 body/frame 上的锐利背景图（改由独立背景层显示），避免重复/遮盖
            body.style.backgroundImage = 'none'
            if (c.enabled && c.bgImage) { body.style.backgroundColor = 'transparent' } else { body.style.backgroundColor = '' }
            if (frame) { frame.style.backgroundImage = 'none'; frame.style.backgroundColor = 'transparent' }

            applyTheme()
            // 记录当前主题应用函数，供唯一观察器/mq 调用
            window.__dshGlassApplyTheme = applyTheme
            centerScroll()
            // 侧边栏/顶栏 DOM 变化(会话列表更新等)时重算左栏/顶栏文字，防抖 120ms
            let chromeTimer = null
            const chromeRoots = [...document.querySelectorAll('#root [class*="sidebarCol"],#root [class*="wSkVaW_header"]')]
            const chromeObs = new MutationObserver(() => { if (chromeTimer) clearTimeout(chromeTimer); chromeTimer = setTimeout(applyChromeText, 120) })
            chromeRoots.forEach((r) => chromeObs.observe(r, { childList: true, subtree: true, characterData: true }))
          }
          return () => {
            window.__dshGlassApply = undefined
            window.removeEventListener('resize', centerScroll)
            window.__dshGlassCenter = undefined
            if (window.__dshGlassStyleObs) { window.__dshGlassStyleObs.disconnect(); window.__dshGlassStyleObs = null }
            if (themeMq) themeMq.removeEventListener('change', themeMqHandler)
            window.__dshGlassApplyTheme = undefined
            if (chromeObs) chromeObs.disconnect()
            if (chromeTimer) clearTimeout(chromeTimer)
          }
        }, 'dsh-long-plugins: glass applier')
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'glass-ui', order: 40, label: 'RA-Span' }, GlassSettingsSection))
        ctx.effect(() => {
          fetch('/api/dsh-uploads/glass-config', { cache: 'no-store' }).then((r) => r.json()).then((b) => {
            if (b && b.cfg) { window.__dshGlassApply && window.__dshGlassApply({ ...b.cfg, bgImage: b.bgImage }) }
          }).catch(() => {})
        }, 'dsh-long-plugins: glass boot')
      },
    }

    const inject = Array.from(new Set([
      ...uploadPlugin.inject,
      ...skillDocsPlugin.inject,
      ...tokenUsagePlugin.inject,
      ...mobilePlugin.inject,
      ...workspaceFilesPlugin.inject,
      ...turnRulerPlugin.inject,
      ...glassPlugin.inject,
    ]))

    function apply(ctx) {
      const safeApply = (label, fn) => {
        try {
          fn(ctx)
        } catch (error) {
          console.error('[dsh-long-plugins] ' + label + ' apply failed:', error)
        }
      }
      safeApply('upload', (c) => uploadPlugin.apply(c))
      safeApply('skill-docs', (c) => skillDocsPlugin.apply(c))
      safeApply('token-usage', (c) => tokenUsagePlugin.apply(c))
      safeApply('mobile-hamburger', (c) => mobilePlugin.apply(c))
      safeApply('workspace-files', (c) => workspaceFilesPlugin.apply(c))
      safeApply('turn-ruler', (c) => turnRulerPlugin.apply(c))
      safeApply('glass', (c) => glassPlugin.apply(c))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
