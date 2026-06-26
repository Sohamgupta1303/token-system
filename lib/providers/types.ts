export interface ProviderAdapter {
  // Builds the fetch request to send to the upstream provider
  buildRequest(prompt: string, maxTokens: number): { url: string; init: RequestInit }
  // Extracts plain text from a single SSE line — returns null if the line isn't a content chunk
  parseChunk(line: string): string | null
  // Returns true when the stream is finished
  isDone(line: string): boolean
  // Human-readable name written to the ledger
  modelName: string
}
