// Image provider abstraction. v1 ships one adapter (OpenAI); the interface is
// provider-agnostic so a domestic provider (e.g. SiliconFlow Flux) can be added
// later without touching the tool or UI (PLAN Phase 3).

export interface GenerateImageOptions {
  /** e.g. "1024x1024"; omitted = provider default. */
  size?: string
  /** How many images to generate (default 1). */
  n?: number
  signal?: AbortSignal
}

export interface GeneratedImage {
  bytes: ArrayBuffer
  /** File extension without the dot, e.g. "png". */
  ext: string
}

export interface ImageProvider {
  readonly id: string
  generate(
    prompt: string,
    options?: GenerateImageOptions,
  ): Promise<GeneratedImage[]>
}
