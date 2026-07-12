const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000'
const tenantId = `compose-smoke-${Date.now()}`
const headers = { 'x-tenant-id': tenantId }
const requestTimeoutMs = 10_000
const requirementQuote = '投标人必须提交完整的技术实施方案。'

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
  new Blob([`# 技术要求\n${requirementQuote}`], { type: 'text/plain' }),
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
const requirement = Array.isArray(requirements) ? requirements[0] : null
const locator = requirement?.sourceLocator
const quoteSha256 = await crypto.subtle.digest(
  'SHA-256',
  new TextEncoder().encode(requirementQuote),
)
const expectedQuoteSha256 = Array.from(new Uint8Array(quoteSha256), (byte) =>
  byte.toString(16).padStart(2, '0')).join('')
if (!Array.isArray(requirements) || requirements.length !== 1 ||
    requirement?.extractionMethod !== 'deterministic-rules-v1' ||
    requirement.confidence !== 0.95 || requirement.description !== requirementQuote ||
    locator?.kind !== 'txt' || locator.quote !== requirementQuote ||
    locator.quoteSha256 !== expectedQuoteSha256 || locator.parserVersion !== 'deterministic-rules-v1' ||
    locator.start?.line !== 2 || locator.start?.column !== 0 ||
    locator.end?.line !== 2 || locator.end?.column !== requirementQuote.length ||
    locator.sectionPath?.length !== 1 || locator.sectionPath[0] !== '技术要求') {
  throw new Error(`Compose worker did not persist real deterministic evidence: ${JSON.stringify(requirements)}`)
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
