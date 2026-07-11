import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { argv, execArgv, exit, stdout } from 'node:process'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

const FIXED_NOW = '2026-07-11T12:00:00.000Z'

if (isMainThread) {
  const mode = argv[2]
  if (mode === 'source-proof') {
    await runSourceProof()
  } else if (mode === 'invalid-protocol-proof') {
    await runInvalidProtocolProof()
  } else if (mode === 'shared-buffer-protocol-proof') {
    await runSharedBufferProtocolProof()
  } else {
    throw new Error(`Unknown fixture mode: ${String(mode)}`)
  }
} else {
  runWorkerFixture()
}

function runWorkerFixture() {
  if (parentPort === null) throw new Error('Fixture worker requires a parent port')
  if (workerData?.file?.fileName === 'fixture-cpu.txt') {
    const phaseBuffer = workerData.fixtureCpuPhase
    if (!(phaseBuffer instanceof SharedArrayBuffer) ||
        phaseBuffer.byteLength < Int32Array.BYTES_PER_ELEMENT) {
      throw new Error('CPU fixture requires a shared phase buffer')
    }
    const phase = new Int32Array(phaseBuffer, 0, 1)
    Atomics.store(phase, 0, 1)
    const stopAt = performance.now() + 100
    let accumulator = 1
    while (performance.now() < stopAt) {
      accumulator = Math.sqrt(accumulator + 2)
    }
    if (!Number.isFinite(accumulator)) throw new Error('CPU fixture computation failed')
    Atomics.store(phase, 0, 2)
    const requirement = fixtureRequirement(workerData)
    requirement.title = 'CPU-bound fixture requirement'
    requirement.description = 'CPU-bound fixture requirement'
    parentPort.postMessage({ ok: true, requirements: [requirement] })
    parentPort.close()
    return
  }
  const taskId = workerData?.task?.id
  if (taskId === 'fixture-hang') {
    let accumulator = 0
    for (;;) accumulator = Math.sqrt(accumulator + 2)
  }
  if (taskId === 'fixture-crash') throw new Error('REMOTE_SECRET_CRASH')
  if (taskId === 'fixture-exit') exit(0)
  if (taskId === 'fixture-error') {
    parentPort.postMessage({
      ok: false,
      error: {
        code: 'INVALID_TEXT_ENCODING',
        message: 'TXT input must be strictly encoded as UTF-8',
        stack: 'REMOTE_SECRET_STACK',
        cause: { credential: 'REMOTE_SECRET_CREDENTIAL' },
      },
    })
    parentPort.close()
    return
  }
  parentPort.postMessage({ ok: true, requirements: [fixtureRequirement(workerData)] })
  parentPort.close()
}

function fixtureRequirement(request) {
  const file = request.file
  const task = request.task
  return {
    id: 'fixture-requirement',
    tenantId: file.tenantId,
    projectId: file.projectId,
    fileId: file.id,
    taskId: task.id,
    code: 'REQ-0001',
    title: 'Fixture requirement',
    description: 'Fixture requirement',
    category: 'technical',
    priority: 'mandatory',
    confirmationStatus: 'pending',
    confirmationNote: null,
    confirmedAt: null,
    extractionMethod: 'deterministic-rules-v1',
    confidence: 0.95,
    sourceLocator: {
      kind: 'txt',
      version: 1,
      sourceFileId: file.id,
      sourceFileName: file.fileName,
      sourceRevision: 1,
      sourceSha256: file.sha256,
      quote: 'Fixture requirement',
      quoteSha256: createHash('sha256').update('Fixture requirement').digest('hex'),
      textStart: 0,
      textEnd: 19,
      sectionPath: [],
      parserVersion: 'deterministic-rules-v1',
      start: { line: 1, column: 0 },
      end: { line: 1, column: 19 },
    },
    createdAt: request.now,
    updatedAt: request.now,
  }
}

async function runSourceProof() {
  const { IsolatedDocumentParser } = await import(
    '../../src/infrastructure/parser/isolated-document-parser.js'
  )
  const content = Buffer.from('# 技术要求\n投标人必须提交完整的技术实施方案。', 'utf8')
  const file = sourceFile(content)
  const task = sourceTask(file)
  const requirements = await new IsolatedDocumentParser().parse(
    file,
    task,
    FIXED_NOW,
    new globalThis.AbortController().signal,
  )
  const requirement = requirements[0]
  stdout.write(JSON.stringify({
    execArgv,
    count: requirements.length,
    requirement: requirement === undefined ? null : {
      extractionMethod: requirement.extractionMethod,
      confidence: requirement.confidence,
      title: requirement.title,
      sourceLocator: requirement.sourceLocator,
    },
  }))
}

async function runInvalidProtocolProof() {
  const backing = new ArrayBuffer(3)
  const content = new Uint8Array(backing, 1, 1)
  const worker = new Worker(
    new globalThis.URL('../../src/infrastructure/parser/parser-worker.js', import.meta.url),
    {
      workerData: {
        file: { content },
        task: {},
        now: FIXED_NOW,
      },
      transferList: [backing],
    },
  )
  const reply = await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Protocol proof worker exited with ${code}`))
    })
  })
  await worker.terminate()
  stdout.write(JSON.stringify(reply))
}

async function runSharedBufferProtocolProof() {
  const original = Buffer.from('# 技术要求\n投标人必须提交完整的技术实施方案。', 'utf8')
  const content = new Uint8Array(new SharedArrayBuffer(original.length))
  content.set(original)
  const file = sourceFile(content)
  const worker = new Worker(
    new globalThis.URL('../../src/infrastructure/parser/parser-worker.js', import.meta.url),
    {
      workerData: {
        file,
        task: sourceTask(file),
        now: FIXED_NOW,
      },
    },
  )
  const reply = await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Protocol proof worker exited with ${code}`))
    })
  })
  await worker.terminate()
  stdout.write(JSON.stringify(reply))
}

function sourceFile(content) {
  return {
    id: 'file-source-proof',
    tenantId: 'tenant-source-proof',
    projectId: 'project-source-proof',
    fileName: 'requirements.txt',
    mediaType: 'text/plain',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    parseStatus: 'parsing',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    content,
  }
}

function sourceTask(file) {
  return {
    id: 'task-source-proof',
    tenantId: file.tenantId,
    projectId: file.projectId,
    fileId: file.id,
    type: 'document-parse-v1',
    status: 'running',
    progress: 25,
    attempt: 1,
    error: null,
    createdAt: FIXED_NOW,
    startedAt: FIXED_NOW,
    finishedAt: null,
    updatedAt: FIXED_NOW,
  }
}
