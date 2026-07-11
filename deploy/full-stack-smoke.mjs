const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000'
const tenantId = `compose-smoke-${Date.now()}`
const headers = { 'x-tenant-id': tenantId }
const requestTimeoutMs = 10_000

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function request(path, init = {}, timeoutMs = requestTimeoutMs) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${JSON.stringify(body)}`)
  }
  return body
}

async function waitForApi() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      await request('/health', {}, Math.min(requestTimeoutMs, deadline - Date.now()))
      return
    } catch {
      await delay(500)
    }
  }
  throw new Error('Compose API did not become healthy within 60 seconds')
}

await waitForApi()

const projectResponse = await request('/api/v1/projects', {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Compose durable worker smoke' }),
})
const projectId = projectResponse?.data?.id
if (typeof projectId !== 'string') throw new Error('Compose smoke did not receive a project ID')

const form = new FormData()
form.append(
  'file',
  new Blob(['compose durable worker smoke fixture'], { type: 'text/plain' }),
  'compose-smoke.txt',
)
const uploadResponse = await request(`/api/v1/projects/${projectId}/files`, {
  method: 'POST',
  headers,
  body: form,
})
const taskId = uploadResponse?.data?.task?.id
if (typeof taskId !== 'string') throw new Error('Compose smoke did not receive a task ID')

const taskDeadline = Date.now() + 60_000
let task
while (Date.now() < taskDeadline) {
  task = (
    await request(
      `/api/v1/tasks/${taskId}`,
      { headers },
      Math.min(requestTimeoutMs, taskDeadline - Date.now()),
    )
  ).data
  if (task?.status === 'succeeded') break
  if (task?.status === 'failed') {
    throw new Error(`Compose worker failed its task: ${JSON.stringify(task.error)}`)
  }
  await delay(250)
}
if (task?.status !== 'succeeded' || task.attempt !== 1) {
  throw new Error(`Compose worker did not complete exactly one attempt: ${JSON.stringify(task)}`)
}

const requirementsResponse = await request(
  `/api/v1/projects/${projectId}/requirements`,
  { headers },
)
const requirements = requirementsResponse?.data
if (!Array.isArray(requirements) || requirements.length !== 3) {
  throw new Error('Compose worker did not persist the three development fixture requirements')
}

await request(
  `/api/v1/projects/${projectId}/requirements/${requirements[0].id}/confirmation`,
  {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'confirmed', note: 'compose smoke' }),
  },
)

process.stdout.write(`${JSON.stringify({ status: 'ok', tenantId, projectId, taskId })}\n`)
