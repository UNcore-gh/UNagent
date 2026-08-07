// hermes 通告命令注册表的纯函数层——available_commands_update 帧解析容错、
// 用户隐藏名单（用户级修订：原硬编码隐藏名单已移除，九条全露出）、选中
// 动作绑定（advertisedSelectAction）、/reset 确认文案、选中预填串、静态兜
// 底清单。

import {
  advertisedSelectAction,
  buildHermesPanelCommands,
  commandPrefill,
  filterAdvertisedCommands,
  HERMES_ADVERTISED_FALLBACK,
  HERMES_RESET_CONFIRM,
  parseAvailableCommandsUpdate,
  type HermesAdvertisedCommand,
} from '../advertisedCommands'

/** hermes acp_adapter/server.py _ADVERTISED_COMMANDS 的真实帧形态。 */
const REAL_FRAME = {
  sessionUpdate: 'available_commands_update',
  availableCommands: [
    { name: 'help', description: 'List available commands' },
    {
      name: 'model',
      description: 'Show current model and provider, or switch models',
      input: { kind: 'unstructured', hint: 'model name to switch to' },
    },
    { name: 'tools', description: 'List available tools with descriptions' },
    { name: 'context', description: 'Show conversation message counts by role' },
    { name: 'reset', description: 'Clear conversation history' },
    { name: 'compress', description: 'Compress conversation context' },
    {
      name: 'steer',
      description: 'Inject guidance into the currently running agent turn',
      input: { kind: 'unstructured', hint: 'guidance for the active turn' },
    },
    {
      name: 'queue',
      description: 'Queue a prompt to run after the current turn finishes',
      input: { kind: 'unstructured', hint: 'prompt to run next' },
    },
    { name: 'version', description: 'Show Hermes version' },
  ],
}

describe('parseAvailableCommandsUpdate', () => {
  it('非该类型帧返回 null（与「清单为空」区分语义）', () => {
    expect(parseAvailableCommandsUpdate(null)).toBeNull()
    expect(parseAvailableCommandsUpdate('x')).toBeNull()
    expect(
      parseAvailableCommandsUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    ).toBeNull()
  })

  it('真实帧解析出九条：name/description/input.hint 全落位', () => {
    const cmds = parseAvailableCommandsUpdate(REAL_FRAME)
    expect(cmds).not.toBeNull()
    expect(cmds!.map((c) => c.name)).toEqual([
      'help',
      'model',
      'tools',
      'context',
      'reset',
      'compress',
      'steer',
      'queue',
      'version',
    ])
    const model = cmds!.find((c) => c.name === 'model')
    expect(model?.inputHint).toBe('model name to switch to')
    const tools = cmds!.find((c) => c.name === 'tools')
    expect(tools?.description).toBe('List available tools with descriptions')
    expect(tools?.inputHint).toBeUndefined()
  })

  it('清单缺失/畸形 → 空数组（hermes 明确说「没有命令」）', () => {
    expect(
      parseAvailableCommandsUpdate({ sessionUpdate: 'available_commands_update' }),
    ).toEqual([])
    expect(
      parseAvailableCommandsUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: 'nope',
      }),
    ).toEqual([])
  })

  it('条目级容错：name 非字符串/空串的条目丢弃，其余保留', () => {
    const cmds = parseAvailableCommandsUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'tools' },
        { name: 42 },
        { name: '' },
        null,
        { description: 'anonymous' },
        { name: 'queue' },
      ],
    })
    expect(cmds!.map((c) => c.name)).toEqual(['tools', 'queue'])
  })

  it('宽松兼容扁平 inputHint 写法；空 hint 不落位', () => {
    const cmds = parseAvailableCommandsUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'a', inputHint: 'flat hint' },
        { name: 'b', input: { kind: 'unstructured', hint: '' } },
        { name: 'c', input: { kind: 'other' } },
      ],
    })
    expect(cmds!.find((c) => c.name === 'a')?.inputHint).toBe('flat hint')
    expect(cmds!.find((c) => c.name === 'b')?.inputHint).toBeUndefined()
    expect(cmds!.find((c) => c.name === 'c')?.inputHint).toBeUndefined()
  })
})

describe('用户隐藏名单（用户级修订：九条全露出，用户层只做加法）', () => {
  const ALL_NINE: HermesAdvertisedCommand[] = HERMES_ADVERTISED_FALLBACK.map(
    (c) => ({ ...c }),
  )

  it('空用户名单 → 九条原样全露出（原硬编码隐藏名单已移除）', () => {
    const kept = filterAdvertisedCommands(ALL_NINE, []).map((c) => c.name)
    expect(kept).toEqual([
      'help',
      'model',
      'tools',
      'context',
      'reset',
      'compress',
      'steer',
      'queue',
      'version',
    ])
  })

  it('用户加法隐藏仍生效：隐藏 version 剩八条', () => {
    const kept = filterAdvertisedCommands(ALL_NINE, ['version']).map(
      (c) => c.name,
    )
    expect(kept).toHaveLength(8)
    expect(kept).not.toContain('version')
  })

  it('用户可同时隐藏多条（含原硬编码条目——现在与普通条目无差别）', () => {
    const kept = filterAdvertisedCommands(ALL_NINE, ['queue', 'model']).map(
      (c) => c.name,
    )
    expect(kept).toEqual([
      'help',
      'tools',
      'context',
      'reset',
      'compress',
      'steer',
      'version',
    ])
  })
})

describe('buildHermesPanelCommands（面板合并：通告 + 合成命令常驻）', () => {
  it('live 注册表有内容时也并入合成命令 mode（不随 live 消失）', () => {
    const live = REAL_FRAME.availableCommands.map((c) => ({
      name: c.name,
      ...('input' in c ? { inputHint: c.input?.hint } : {}),
    }))
    const kept = buildHermesPanelCommands(live, []).map((c) => c.name)
    expect(kept).toEqual([
      'help',
      'model',
      'tools',
      'context',
      'reset',
      'compress',
      'steer',
      'queue',
      'version',
      'mode',
    ])
  })

  it('兜底清单路径同样并入合成命令', () => {
    const kept = buildHermesPanelCommands(
      [...HERMES_ADVERTISED_FALLBACK],
      [],
    ).map((c) => c.name)
    expect(kept[kept.length - 1]).toBe('mode')
  })

  it('合成命令同样过用户隐藏名单', () => {
    const kept = buildHermesPanelCommands(
      [...HERMES_ADVERTISED_FALLBACK],
      ['mode', 'version'],
    ).map((c) => c.name)
    expect(kept).not.toContain('mode')
    expect(kept).not.toContain('version')
  })
})

describe('advertisedSelectAction（行为绑定表 + 默认规则）', () => {
  it('model → model-menu（例外：开窗不预填不发送，即使带 hint）', () => {
    expect(
      advertisedSelectAction({ name: 'model', inputHint: 'model name' }),
    ).toBe('model-menu')
  })

  it('mode → mode-menu（例外：开审批模式选择窗，不预填不发送）', () => {
    expect(advertisedSelectAction({ name: 'mode' })).toBe('mode-menu')
  })

  it('有 inputHint（steer/queue）→ prefill（预填 `/<name> ` 光标接参数）', () => {
    expect(
      advertisedSelectAction({
        name: 'steer',
        inputHint: 'guidance for the active turn',
      }),
    ).toBe('prefill')
    expect(
      advertisedSelectAction({ name: 'queue', inputHint: 'prompt to run next' }),
    ).toBe('prefill')
  })

  it('无 hint（help/tools/context/compress/version/reset）→ send（选中即发）', () => {
    for (const name of ['help', 'tools', 'context', 'compress', 'version', 'reset']) {
      expect(advertisedSelectAction({ name })).toBe('send')
    }
    // mode 是例外，返回 mode-menu 而非 send
    expect(advertisedSelectAction({ name: 'mode' })).toBe('mode-menu')
  })
})

describe('HERMES_RESET_CONFIRM（/reset 透传前置确认文案）', () => {
  it('标题 = 「确认 /reset」；文案明示 hermes 侧清空、插件侧保留、两边脱节', () => {
    expect(HERMES_RESET_CONFIRM.title).toBe('确认 /reset')
    expect(HERMES_RESET_CONFIRM.message).toContain('将清空 hermes 侧对话历史')
    expect(HERMES_RESET_CONFIRM.message).toContain('插件侧消息保留')
    expect(HERMES_RESET_CONFIRM.message).toContain('两边会脱节')
  })
})

describe('commandPrefill（选中预填串）', () => {
  it('`/<name> ` 带尾空格，光标接参数', () => {
    expect(commandPrefill('steer')).toBe('/steer ')
    expect(commandPrefill('queue')).toBe('/queue ')
  })
})

describe('HERMES_ADVERTISED_FALLBACK（静态兜底清单）', () => {
  it('与 hermes _ADVERTISED_COMMANDS 九条逐条对齐（含三条 input hint）', () => {
    expect(HERMES_ADVERTISED_FALLBACK.map((c) => c.name)).toEqual(
      REAL_FRAME.availableCommands.map((c) => c.name),
    )
    for (const src of REAL_FRAME.availableCommands) {
      const fb = HERMES_ADVERTISED_FALLBACK.find((c) => c.name === src.name)
      expect(fb).toBeDefined()
      const hint = 'input' in src ? src.input?.hint : undefined
      expect(fb?.inputHint).toBe(hint)
    }
  })
})
