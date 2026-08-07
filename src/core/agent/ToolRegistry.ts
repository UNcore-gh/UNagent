// Central registry of note-management tools. Singleton, mirrors the metadata
// design borrowed from copilot (category / requiresVault / destructive) but
// stores plain Tool objects instead of LangChain tools.

import type { ChatCompletionTool } from '../llm/base'
import type { Tool } from './types'

export class ToolRegistry {
  private static instance: ToolRegistry
  private tools = new Map<string, Tool>()

  private constructor() {}

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry()
    }
    return ToolRegistry.instance
  }

  register(tool: Tool): void {
    this.tools.set(tool.metadata.name, tool)
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) this.register(tool)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  getByName(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  /** Convert registered tools into the LLM-agnostic tool schema list. */
  toLLMTools(): ChatCompletionTool[] {
    return this.getAll().map((tool) => ({
      type: 'function',
      function: {
        name: tool.metadata.name,
        description: tool.metadata.description,
        parameters: tool.metadata.parameters,
      },
    }))
  }

  clear(): void {
    this.tools.clear()
  }
}
