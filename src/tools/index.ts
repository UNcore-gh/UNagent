// Aggregates the v1 note-management tool set and registers it with the
// singleton ToolRegistry. Called once from main.ts onload.

import { Platform } from 'obsidian'
import { ToolRegistry } from '../core/agent/ToolRegistry'
import type { Tool } from '../core/agent/types'
import { addTagTool } from './addTag'
import { askUserTool } from './askUser'
import { createNoteTool } from './createNote'
import { deleteNoteTool } from './deleteNote'
import { editNoteTool } from './editNote'
import { generateImageTool } from './generateImage'
import { libraryIndexTool } from './libraryIndex'
import { listNotesTool } from './listNotes'
import { loadSkillTool } from './loadSkill'
import { readNoteTool } from './readNote'
import { renameOrMoveTool } from './renameOrMove'
import { saveMemoryTool } from './saveMemory'
import { searchNotesTool } from './searchNotes'
import { semanticSearchTool } from './semanticSearch'
import { todoWriteTool } from './todoWrite'
import { updateFrontmatterTool } from './updateFrontmatter'

export const ALL_TOOLS: Tool[] = [
  searchNotesTool,
  semanticSearchTool,
  libraryIndexTool,
  listNotesTool,
  readNoteTool,
  createNoteTool,
  editNoteTool,
  updateFrontmatterTool,
  addTagTool,
  renameOrMoveTool,
  deleteNoteTool,
  generateImageTool,
  loadSkillTool,
  saveMemoryTool,
  todoWriteTool,
  askUserTool,
]

/** 补刀·五十四（铁律一修订版）：desktopOnly 工具只在桌面端注册——移动
 *  端连 schema 都看不到。非 desktopOnly 工具不受影响。 */
export function filterToolsForPlatform(tools: Tool[]): Tool[] {
  return tools.filter((t) => !t.metadata.desktopOnly || !Platform.isMobile)
}

export function registerAllTools(): ToolRegistry {
  const registry = ToolRegistry.getInstance()
  registry.registerAll(filterToolsForPlatform(ALL_TOOLS))
  return registry
}
