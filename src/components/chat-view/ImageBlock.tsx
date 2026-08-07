import { Notice, TFile } from 'obsidian'
import { useCallback, useEffect, useState } from 'react'

import { usePlugin } from '../../contexts/plugin-context'
import { removePath } from '../../utils/vaultIO'

// Output shape of the generate_image tool.
interface ImageOutput {
  path: string
  name: string
  embed: string
}

function asImageOutput(output: unknown): ImageOutput | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  if (typeof o.path !== 'string' || typeof o.name !== 'string') return null
  return {
    path: o.path,
    name: o.name,
    embed: typeof o.embed === 'string' ? o.embed : `![[${o.name}]]`,
  }
}

// Renders a generated image thumbnail with quick actions: insert into the
// active note, open the file, copy to clipboard, or delete. Images live in
// the plugin's data folder (AI 助手/images/ by default).
export const ImageBlock = ({ output }: { output: unknown }) => {
  const plugin = usePlugin()
  const data = asImageOutput(output)
  const [src, setSrc] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)

  useEffect(() => {
    if (!data) return
    const file = plugin.app.vault.getAbstractFileByPath(data.path)
    setSrc(file instanceof TFile ? plugin.app.vault.getResourcePath(file) : null)
  }, [plugin, data?.path])

  if (!data || deleted) return null

  const requireActiveFile = () => {
    const active = plugin.app.workspace.getActiveFile()
    if (!active) {
      new Notice('请先打开一个笔记')
      return null
    }
    return active
  }

  const insertIntoActive = async () => {
    const file = requireActiveFile()
    if (!file) return
    const original = await plugin.app.vault.read(file)
    await plugin.app.vault.modify(
      file,
      original.replace(/\s*$/, '') + `\n\n${data.embed}\n`,
    )
    plugin.undoStack.push(`在 ${file.basename} 插入图片`, async () => {
      await plugin.app.vault.modify(file, original)
    })
    new Notice(`已插入到 ${file.name}`)
  }

  const openImage = () => {
    void plugin.app.workspace.openLinkText(data.name, '')
  }

  const copyImage = useCallback(async () => {
    if (!src) return
    try {
      const res = await fetch(src)
      const blob = await res.blob()
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ])
      new Notice('图片已复制到剪贴板')
    } catch {
      new Notice('复制图片失败')
    }
  }, [src])

  const deleteImage = useCallback(async () => {
    if (!data) return
    try {
      await removePath(plugin.app, data.path)
      setDeleted(true)
      new Notice('图片已删除')
    } catch {
      new Notice('删除图片失败')
    }
  }, [plugin, data?.path])

  return (
    <div className="UNagent-image">
      {src ? (
        <img className="UNagent-image-thumb" src={src} alt={data.name} />
      ) : (
        <div className="UNagent-image-missing">图片未找到：{data.path}</div>
      )}
      <div className="UNagent-image-actions">
        <button
          className="UNagent-image-icon-btn"
          onClick={insertIntoActive}
          aria-label="插入到当前笔记"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          className="UNagent-image-icon-btn"
          onClick={openImage}
          aria-label="打开图片"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
        <button
          className="UNagent-image-icon-btn"
          onClick={copyImage}
          aria-label="复制图片"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button
          className="UNagent-image-icon-btn UNagent-image-icon-btn--danger"
          onClick={deleteImage}
          aria-label="删除图片"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  )
}
