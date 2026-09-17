import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
const server = await startMockLlmServer({ host: '0.0.0.0', sequence: ['success'], apiKey: 'container-key', successText: 'CONTAINER OK', repeatLast: true })
console.log('MOCK_PORT=' + server.baseURL.split(':').slice(-1)[0].split('/')[0])
await new Promise(() => {})
