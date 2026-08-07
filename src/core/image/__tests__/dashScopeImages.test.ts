// DashScopeImagesProvider tests: async task submit → poll → download chain,
// size format conversion, and failure/timeout paths.

import { DashScopeImagesProvider } from '../dashScopeImages'
import { LLMError } from '../../llm/errors'

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

function bytesResponse(): Response {
  return {
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response
}

describe('DashScopeImagesProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('submits an async task, polls to SUCCEEDED, downloads the image', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ output: { task_id: 'task-1', task_status: 'PENDING' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ url: 'https://oss.example.com/img.png' }],
          },
        }),
      )
      .mockResolvedValueOnce(bytesResponse())

    const provider = new DashScopeImagesProvider(
      { apiKey: 'k', model: 'qwen-image-plus', size: '1024x1024' },
      { pollMs: 1, timeoutMs: 5000 },
    )
    const images = await provider.generate('a red apple')

    expect(images).toHaveLength(1)
    expect(images[0].ext).toBe('png')
    expect(images[0].bytes.byteLength).toBe(8)

    // 提交请求：原生端点 + 异步头 + 尺寸星号格式
    const submitCall = fetchMock.mock.calls[0]
    expect(String(submitCall[0])).toContain(
      '/api/v1/services/aigc/text2image/image-synthesis',
    )
    const init = submitCall[1] as RequestInit
    expect((init.headers as Record<string, string>)['X-DashScope-Async']).toBe('enable')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('qwen-image-plus')
    expect(body.input.prompt).toBe('a red apple')
    expect(body.parameters.size).toBe('1024*1024')

    // 轮询请求：任务端点
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/v1/tasks/task-1')
    // 下载请求：图片 URL
    expect(String(fetchMock.mock.calls[2][0])).toBe('https://oss.example.com/img.png')
  })

  it('omits size when unset', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ output: { task_id: 't' } }))
      .mockResolvedValueOnce(
        jsonResponse({ output: { task_status: 'SUCCEEDED', results: [{ url: 'u' }] } }),
      )
      .mockResolvedValueOnce(bytesResponse())

    const provider = new DashScopeImagesProvider(
      { apiKey: 'k', model: 'm', size: '' },
      { pollMs: 1, timeoutMs: 5000 },
    )
    await provider.generate('p')
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.parameters.size).toBeUndefined()
  })

  it('throws http error when the task FAILED', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ output: { task_id: 't' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          output: { task_status: 'FAILED' },
          message: '模型生成超时',
        }),
      )

    const provider = new DashScopeImagesProvider(
      { apiKey: 'k', model: 'm', size: '' },
      { pollMs: 1, timeoutMs: 5000 },
    )
    await expect(provider.generate('p')).rejects.toMatchObject({
      code: 'http',
      message: '生图任务失败：模型生成超时',
    })
  })

  it('throws http error on submit without task id', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ code: 'InvalidParameter', message: 'bad' }))

    const provider = new DashScopeImagesProvider(
      { apiKey: 'k', model: 'm', size: '' },
      { pollMs: 1, timeoutMs: 5000 },
    )
    await expect(provider.generate('p')).rejects.toMatchObject({
      code: 'http',
      message: 'bad',
    })
  })

  it('times out while the task stays PENDING', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ output: { task_id: 't' } }))
      .mockResolvedValue(jsonResponse({ output: { task_status: 'PENDING' } }))

    const provider = new DashScopeImagesProvider(
      { apiKey: 'k', model: 'm', size: '' },
      { pollMs: 1, timeoutMs: 10 },
    )
    await expect(provider.generate('p')).rejects.toMatchObject({
      code: 'http',
      message: '生图任务超时，请稍后重试',
    })
  })

  it('throws http error when downloading the image fails', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ output: { task_id: 't' } }))
      .mockResolvedValueOnce(
        jsonResponse({ output: { task_status: 'SUCCEEDED', results: [{ url: 'u' }] } }),
      )
      .mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response)

    const provider = new DashScopeImagesProvider(
      { apiKey: 'k', model: 'm', size: '' },
      { pollMs: 1, timeoutMs: 5000 },
    )
    await expect(provider.generate('p')).rejects.toMatchObject({
      code: 'http',
      message: '下载生成的图片失败（403）',
    })
  })

  it('rejects with typed errors for missing config', async () => {
    const provider = new DashScopeImagesProvider(
      { apiKey: '', model: '', size: '' },
      { pollMs: 1, timeoutMs: 5000 },
    )
    await expect(provider.generate('p')).rejects.toBeInstanceOf(LLMError)
  })
})
