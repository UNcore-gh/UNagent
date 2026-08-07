// Command registry invariants + M2-T4 capability gating & panel view build:
// unique ids, complete display fields, requiresCapability filtering
// (/think hermes 隐藏、/compact 双引擎可见), 面板合并（Hermes 来源标注 +
// 行为绑定表 kind 映射 + model 去重）与用户隐藏名单（用户级修订：九条全露出）。

import {
  advertisedToCommandDef,
  buildPanelCommands,
  COMMANDS,
  CORE_ONLY_COMMANDS,
  filterCommandsForEngine,
  parseHermesModeArg,
} from '../commands'
import type { HermesAdvertisedCommand } from '../../../core/hermes/advertisedCommands'

describe('COMMANDS registry', () => {
  it('has unique ids and complete display fields', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const cmd of COMMANDS) {
      expect(cmd.label.length).toBeGreaterThan(0)
      expect(cmd.description.length).toBeGreaterThan(0)
      expect(cmd.icon.length).toBeGreaterThan(0)
      expect(['menu', 'insert', 'immediate']).toContain(cmd.kind)
    }
  })

  it('registers the /mcp management command as immediate', () => {
    const mcp = COMMANDS.find((c) => c.id === 'mcp')
    expect(mcp).toBeDefined()
    expect(mcp?.kind).toBe('immediate')
  })

  it('/think 挂 extendedThinking；/compact 刻意不挂（双引擎可见，hermes 走 T5 路由）', () => {
    expect(COMMANDS.find((c) => c.id === 'think')?.requiresCapability).toBe(
      'extendedThinking',
    )
    expect(COMMANDS.find((c) => c.id === 'compact')?.requiresCapability).toBeUndefined()
  })

  it('M2-T8：/mode 双引擎可见——去 approvalModes 门控，kind=menu（命令面板选中即弹选择窗）', () => {
    const mode = COMMANDS.find((c) => c.id === 'mode')
    expect(mode).toBeDefined()
    expect(mode?.label).toBe('审批模式')
    expect(mode?.kind).toBe('menu')
    expect(mode?.requiresCapability).toBeUndefined()
  })

  it('/hermes-open 挂 hermesDesktop 门控（仅 hermes 引擎可见）', () => {
    const open = COMMANDS.find((c) => c.id === 'hermes-open')
    expect(open).toBeDefined()
    expect(open?.label).toBe('在 Hermes 桌面端打开')
    expect(open?.kind).toBe('immediate')
    expect(open?.requiresCapability).toBe('hermesDesktop')
  })

  it('/hermes-init 挂 hermesDesktop 门控（仅 hermes 引擎面板显示）且为 immediate', () => {
    const init = COMMANDS.find((c) => c.id === 'hermes-init')
    expect(init).toBeDefined()
    expect(init?.label).toBe('初始化对话同步')
    expect(init?.kind).toBe('immediate')
    expect(init?.usage).toBe('/hermes-init')
    expect(init?.requiresCapability).toBe('hermesDesktop')
    expect(CORE_ONLY_COMMANDS).not.toContain('hermes-init')
  })
})

describe('filterCommandsForEngine (capability gating)', () => {
  it('core 引擎：能力门控只隐藏 /hermes-open 与 /hermes-init；/mode 双引擎可见（M2-T8）', () => {
    const ids = filterCommandsForEngine(COMMANDS, 'core').map((c) => c.id)
    // M2-T8：/mode 不再挂门控——core 引擎写 SafetySettings.approvalMode。
    // /hermes-open 与 /hermes-init 仍隐藏：core 对话没有 hermes 会话，
    // 桌面端打开 / 对话同步初始化均无意义。
    expect(ids).toContain('mode')
    expect(ids).not.toContain('hermes-open')
    expect(ids).not.toContain('hermes-init')
    expect(ids).toEqual(
      COMMANDS.map((c) => c.id).filter(
        (id) => id !== 'hermes-open' && id !== 'hermes-init',
      ),
    )
  })

  it('hermes 引擎隐藏 /think（extendedThinking 门控）但保留 /model、/mode、/compact、/hermes-open 与 /hermes-init', () => {
    const ids = filterCommandsForEngine(COMMANDS, 'hermes').map((c) => c.id)
    expect(ids).not.toContain('think')
    // M2-T1 不回归：/model 已移出旧 CLOUD_ONLY，hermes 路径弹 hermes 清单。
    expect(ids).toContain('model')
    // M2-T8：/mode 双引擎可见——hermes 引擎经会话 set_mode + override 生效。
    expect(ids).toContain('mode')
    // M2-T5：/compact 在 hermes 下路由改写为 /compress，靠路由不靠隐藏。
    expect(ids).toContain('compact')
    // 桌面端打开 / 对话同步初始化：hermesDesktop 门控 → hermes 引擎可见。
    expect(ids).toContain('hermes-open')
    expect(ids).toContain('hermes-init')
  })

  it('hermes 引擎隐藏 core-only 清单（btw/hermes/learn）', () => {
    const ids = filterCommandsForEngine(COMMANDS, 'hermes').map((c) => c.id)
    for (const id of CORE_ONLY_COMMANDS) {
      expect(ids).not.toContain(id)
    }
    expect(CORE_ONLY_COMMANDS).toEqual(['btw', 'hermes', 'learn'])
  })

  it('hermes 引擎保留路径无关命令', () => {
    const ids = filterCommandsForEngine(COMMANDS, 'hermes').map((c) => c.id)
    for (const id of [
      'hermes-mode',
      'hermes-open',
      'chats',
      'new',
      'branch',
      'rewind',
      'edit',
      'settings',
      'mcp',
    ]) {
      expect(ids).toContain(id)
    }
  })

  it('用户隐藏名单按引擎生效（只做加法）', () => {
    const core = filterCommandsForEngine(COMMANDS, 'core', ['compact']).map(
      (c) => c.id,
    )
    expect(core).not.toContain('compact')
    expect(core).toContain('btw')
    const hermes = filterCommandsForEngine(COMMANDS, 'hermes', ['model']).map(
      (c) => c.id,
    )
    expect(hermes).not.toContain('model')
    // think 依然被能力门控隐藏（用户名单不影响门控）。
    expect(hermes).not.toContain('think')
  })
})

describe('advertisedToCommandDef（Hermes 来源标注 + 行为绑定表 kind 映射）', () => {
  it('有 hint 通告命令转 CommandDef：kind=insert（预填）、source/badge 标 Hermes、usage 带 hint', () => {
    const def = advertisedToCommandDef({
      name: 'steer',
      description: 'Inject guidance into the currently running agent turn',
      inputHint: 'guidance for the active turn',
    })
    expect(def.id).toBe('steer')
    expect(def.kind).toBe('insert')
    expect(def.source).toBe('hermes')
    expect(def.badge).toBe('Hermes')
    expect(def.usage).toBe('/steer <guidance for the active turn>')
    expect(def.description.length).toBeGreaterThan(0)
    expect(def.icon.length).toBeGreaterThan(0)
  })

  it('无 hint 时 usage 为裸命令词、kind=immediate（选中即发）；目录表收录命令润色、未收录回退通告描述', () => {
    const def = advertisedToCommandDef({
      name: 'tools',
      description: 'List available tools with descriptions',
    })
    expect(def.usage).toBe('/tools')
    // 默认规则：无 hint → 选中即发送（经 hermes 轮原样透传）。
    expect(def.kind).toBe('immediate')
    for (const name of ['help', 'context', 'compress', 'version', 'reset']) {
      expect(advertisedToCommandDef({ name }).kind).toBe('immediate')
    }
    // HERMES_COMMAND_CATALOG 收录 → 中文润色优先于通告原文。
    expect(def.label).toBe('工具列表')
    const unknown = advertisedToCommandDef({
      name: 'frobnicate',
      description: 'Does things',
    })
    expect(unknown.label).toBe('frobnicate')
    expect(unknown.icon).toBe('terminal')
    expect(unknown.description).toBe('Does things')
    const bare = advertisedToCommandDef({ name: 'frobnicate' })
    expect(bare.description).toBe('Hermes 原生命令')
  })

  it('model → kind=menu（行为绑定表例外：选中开模型选择窗，不预填不发送）', () => {
    const def = advertisedToCommandDef({
      name: 'model',
      description: 'Switch models',
      inputHint: 'model name to switch to',
    })
    expect(def.kind).toBe('menu')
    expect(def.source).toBe('hermes')
  })
})

describe('buildPanelCommands（面板合并渲染的纯逻辑）', () => {
  const advertised: HermesAdvertisedCommand[] = [
    { name: 'tools', description: 'List available tools' },
    { name: 'queue', description: 'Queue a prompt', inputHint: 'prompt to run next' },
    // 与插件自有 /model 同名——hermes 引擎下去重（保留插件菜单项）。
    { name: 'model', description: 'Switch models' },
    { name: 'version', description: 'Show Hermes version' },
  ]

  it('core 引擎：只出插件命令（/hermes-open 与 /hermes-init 被能力门控隐藏，/mode 保留），通告命令一律不并入', () => {
    const panel = buildPanelCommands('core', advertised)
    expect(panel.some((c) => c.source === 'hermes')).toBe(false)
    expect(panel.map((c) => c.id)).toEqual(
      COMMANDS.map((c) => c.id).filter(
        (id) => id !== 'hermes-open' && id !== 'hermes-init',
      ),
    )
  })

  it('hermes 引擎：通告九条全露出（version 不再隐藏）+ Hermes 徽章', () => {
    const panel = buildPanelCommands('hermes', advertised)
    const ids = panel.map((c) => c.id)
    // 插件侧：think/btw/hermes/learn 隐藏，model/compact 保留。
    for (const id of ['think', 'btw', 'hermes', 'learn']) {
      expect(ids).not.toContain(id)
    }
    expect(ids).toContain('compact')
    // 任务一 §1.2：hermes 面板含 /mode。
    expect(ids).toContain('mode')
    // 用户级修订：version（原硬编码隐藏）现在露出。
    expect(ids).toContain('version')
    expect(ids).toContain('tools')
    expect(ids).toContain('queue')
    const tools = panel.find((c) => c.id === 'tools')
    expect(tools?.source).toBe('hermes')
    expect(tools?.badge).toBe('Hermes')
    // 默认规则：无 hint → immediate（选中即发）；有 hint → insert（预填）。
    expect(tools?.kind).toBe('immediate')
    expect(panel.find((c) => c.id === 'queue')?.kind).toBe('insert')
    expect(panel.find((c) => c.id === 'version')?.kind).toBe('immediate')
  })

  it('hermes 引擎：model 去重——面板中 model 唯一且为插件菜单入口（选中开窗）', () => {
    const panel = buildPanelCommands('hermes', advertised)
    const models = panel.filter((c) => c.id === 'model')
    expect(models).toHaveLength(1)
    // 保留的是插件自有 /model（kind='menu'，hermes 路径弹 hermes 模型清单），
    // 通告侧 model 不并入（无双入口）。
    expect(models[0].kind).toBe('menu')
    expect(models[0].source).toBeUndefined()
  })

  it('hermes 引擎：用户隐藏名单同时作用于插件命令与通告命令', () => {
    const panel = buildPanelCommands('hermes', advertised, {
      hermes: ['compact', 'tools'],
    })
    const ids = panel.map((c) => c.id)
    expect(ids).not.toContain('compact')
    expect(ids).not.toContain('tools')
    expect(ids).toContain('queue')
    // 用户隐藏 model → 双侧同名同时消失（面板无 model 入口）。
    const panel2 = buildPanelCommands('hermes', advertised, {
      hermes: ['model'],
    })
    expect(panel2.filter((c) => c.id === 'model')).toHaveLength(0)
  })

  it('hidden 参数缺省/畸形侧缺省为空名单', () => {
    expect(buildPanelCommands('hermes', advertised).map((c) => c.id)).toEqual(
      buildPanelCommands('hermes', advertised, {}).map((c) => c.id),
    )
  })
})

describe('parseHermesModeArg（/mode 中文别名映射）', () => {
  it('三组中文别名各自归一到 hermes 模式 id', () => {
    expect(parseHermesModeArg('默认')).toBe('default')
    expect(parseHermesModeArg('询问')).toBe('default')
    expect(parseHermesModeArg('自动')).toBe('accept_edits')
    expect(parseHermesModeArg('自动审批')).toBe('accept_edits')
    expect(parseHermesModeArg('免询')).toBe('dont_ask')
    expect(parseHermesModeArg('不要询问')).toBe('dont_ask')
  })

  it('英文 id 原样接受（大小写/前后空白宽容）', () => {
    expect(parseHermesModeArg('default')).toBe('default')
    expect(parseHermesModeArg('  accept_edits ')).toBe('accept_edits')
    expect(parseHermesModeArg('DONT_ASK')).toBe('dont_ask')
  })

  it('空参/未知参数返回 null（路由给用法提示/弹窗）', () => {
    expect(parseHermesModeArg('')).toBeNull()
    expect(parseHermesModeArg('   ')).toBeNull()
    expect(parseHermesModeArg('放飞自我')).toBeNull()
    expect(parseHermesModeArg('plan')).toBeNull()
  })
})
