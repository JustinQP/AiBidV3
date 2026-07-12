import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseError, Pool } from 'pg'
import { DevelopmentDocumentParser } from '../../application/development-document-parser.js'
import { FileContentLoader } from '../../application/file-content-loader.js'
import { loadConfig } from '../../config.js'
import type {
  NewUpload,
  Requirement,
  TxtSourceLocatorV1,
} from '../../domain/models.js'
import { originalObjectKey, type ObjectReference } from '../../domain/object-storage.js'
import { createObjectStorage } from '../object-storage-factory.js'
import { createId } from '../../lib/id.js'
import { PostgresBidRepository } from './postgres-repository.js'

const config = loadConfig()
const databaseUrl = config.databaseUrl
if (!databaseUrl) throw new Error('DATABASE_URL is required for the PostgreSQL smoke test')

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
})
const repository = new PostgresBidRepository(pool)
const objectStorage = createObjectStorage(config)
const tenantId = `smoke-${createId().toLowerCase()}`
const projectId = createId()
const now = new Date().toISOString()
let uploadedObject: ObjectReference | null = null

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

type RealTxtRequirement = Requirement & {
  extractionMethod: 'deterministic-rules-v1'
  confidence: number
  sourceLocator: TxtSourceLocatorV1
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

async function expectRejected(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch {
    return
  }
  throw new Error(`PostgreSQL evidence migration smoke accepted ${label}`)
}

async function expectRuntimeRejected(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof DatabaseError) {
      throw new Error(
        `Expected runtime validation to reject ${label}, but PostgreSQL rejected it with SQLSTATE ${error.code}`,
        { cause: error },
      )
    }
    if (!(error instanceof Error)) {
      throw new Error(`Runtime validation rejected ${label} with a non-Error value`, {
        cause: error,
      })
    }
    return
  }
  throw new Error(`PostgreSQL evidence migration smoke accepted ${label}`)
}

async function insertMigrationTask(
  migrationPool: Pool,
  input: {
    id: string
    tenantId: string
    projectId: string
    fileId: string
    type: 'development-document-parse' | 'document-parse-v1'
    now: string
  },
): Promise<void> {
  await migrationPool.query(
    `INSERT INTO parse_tasks (
      id, tenant_id, project_id, file_id, type, status, progress, error,
      created_at, started_at, finished_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,'queued',0,NULL,$6,NULL,NULL,$6)`,
    [input.id, input.tenantId, input.projectId, input.fileId, input.type, input.now],
  )
}

function realTxtRequirement(input: {
  tenantId: string
  projectId: string
  fileId: string
  fileName: string
  fileSha256: string
  taskId: string
  now: string
  confidence?: number
}): RealTxtRequirement {
  const canonicalText = 'Supplier must retain audit logs.'
  const quote = 'must retain audit logs'
  const textStart = canonicalText.indexOf(quote)
  return {
    id: createId(),
    tenantId: input.tenantId,
    projectId: input.projectId,
    fileId: input.fileId,
    taskId: input.taskId,
    code: `REQ-${createId()}`,
    title: 'Retain audit logs',
    description: quote,
    category: 'compliance',
    priority: 'mandatory',
    confirmationStatus: 'pending',
    confirmationNote: null,
    confirmedAt: null,
    extractionMethod: 'deterministic-rules-v1',
    confidence: input.confidence ?? 0.875,
    sourceLocator: {
      version: 1,
      kind: 'txt',
      sourceFileId: input.fileId,
      sourceFileName: input.fileName,
      sourceRevision: 1,
      sourceSha256: input.fileSha256,
      quote,
      quoteSha256: createHash('sha256').update(quote, 'utf8').digest('hex'),
      textStart,
      textEnd: textStart + quote.length,
      sectionPath: ['Audit'],
      parserVersion: 'deterministic-rules-v1',
      start: { line: 1, column: textStart },
      end: { line: 1, column: textStart + quote.length },
    },
    createdAt: input.now,
    updatedAt: input.now,
  }
}

function fixtureRequirement(input: {
  tenantId: string
  projectId: string
  fileId: string
  fileName: string
  taskId: string
  now: string
}): Requirement {
  return {
    id: createId(),
    tenantId: input.tenantId,
    projectId: input.projectId,
    fileId: input.fileId,
    taskId: input.taskId,
    code: `DEV-${createId()}`,
    title: 'Historical fixture',
    description: 'Historical fixture evidence remains readable.',
    category: 'technical',
    priority: 'normal',
    confirmationStatus: 'pending',
    confirmationNote: null,
    confirmedAt: null,
    extractionMethod: 'development-fixture',
    confidence: null,
    sourceLocator: {
      kind: 'development-fixture',
      fileId: input.fileId,
      fileName: input.fileName,
      pageNumber: null,
      sectionPath: ['Fixture'],
      paragraphIndex: null,
      quote: 'Historical fixture evidence remains readable.',
    },
    createdAt: input.now,
    updatedAt: input.now,
  }
}

async function runEvidenceMigrationSmoke(adminPool: Pool, connectionString: string): Promise<void> {
  const schema = `smoke_evidence_${createId().toLowerCase()}`
  const schemaIdentifier = quotedIdentifier(schema)
  let migrationPool: Pool | null = null
  await adminPool.query(`CREATE SCHEMA ${schemaIdentifier}`)
  try {
    migrationPool = new Pool({
      connectionString,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      options: `-c search_path=${schema},pg_catalog`,
    })
    const migrationsDirectory = path.resolve(process.cwd(), 'migrations')
    for (const name of ['0001_initial.sql', '0002_object_storage.sql', '0003_durable_worker.sql']) {
      await migrationPool.query(await readFile(path.join(migrationsDirectory, name), 'utf8'))
    }

    const migrationTenantId = `migration-${createId().toLowerCase()}`
    const migrationProjectId = createId()
    const migrationFileId = createId()
    const historicalTaskId = createId()
    const historicalRequirementId = createId()
    const migrationNow = new Date().toISOString()
    const migrationFileName = 'migration.txt'
    const migrationContent = Buffer.from('Supplier must retain audit logs.', 'utf8')
    const migrationFileSha256 = createHash('sha256').update(migrationContent).digest('hex')

    await migrationPool.query(
      `INSERT INTO projects (
        id, tenant_id, name, code, customer_name, owner_name, deadline, status, created_at, updated_at
      ) VALUES ($1,$2,'Evidence migration smoke',NULL,NULL,NULL,NULL,'draft',$3,$3)`,
      [migrationProjectId, migrationTenantId, migrationNow],
    )
    await migrationPool.query(
      `INSERT INTO project_files (
        id, tenant_id, project_id, file_name, media_type, size_bytes, sha256, content,
        parse_status, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,'text/plain',$5,$6,$7,'parsed',$8,$8)`,
      [
        migrationFileId,
        migrationTenantId,
        migrationProjectId,
        migrationFileName,
        migrationContent.length,
        migrationFileSha256,
        migrationContent,
        migrationNow,
      ],
    )
    await migrationPool.query(
      `INSERT INTO parse_tasks (
        id, tenant_id, project_id, file_id, type, status, progress, error,
        created_at, started_at, finished_at, updated_at
      ) VALUES ($1,$2,$3,$4,'development-document-parse','succeeded',100,NULL,$5,$5,$5,$5)`,
      [
        historicalTaskId,
        migrationTenantId,
        migrationProjectId,
        migrationFileId,
        migrationNow,
      ],
    )
    await migrationPool.query(
      `INSERT INTO requirements (
        id, tenant_id, project_id, file_id, task_id, code, title, description,
        category, priority, confirmation_status, confirmation_note, confirmed_at,
        extraction_method, source_locator, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,'DEV-0001','Historical fixture','Historical fixture evidence remains readable.',
        'technical','normal','pending',NULL,NULL,'development-fixture',$6::jsonb,$7,$7)`,
      [
        historicalRequirementId,
        migrationTenantId,
        migrationProjectId,
        migrationFileId,
        historicalTaskId,
        JSON.stringify({
          kind: 'development-fixture',
          fileId: migrationFileId,
          fileName: migrationFileName,
          pageNumber: null,
          sectionPath: ['Fixture'],
          paragraphIndex: null,
          quote: 'Historical fixture evidence remains readable.',
        }),
        migrationNow,
      ],
    )

    await migrationPool.query(
      await readFile(path.join(migrationsDirectory, '0004_real_document_parser.sql'), 'utf8'),
    )

    const migrationRepository = new PostgresBidRepository(migrationPool)
    const historical = await migrationRepository.listRequirements(
      migrationTenantId,
      migrationProjectId,
      {},
    )
    if (
      historical.length !== 1 ||
      historical[0]?.id !== historicalRequirementId ||
      historical[0].extractionMethod !== 'development-fixture' ||
      historical[0].confidence !== null ||
      historical[0].sourceLocator.kind !== 'development-fixture'
    ) {
      throw new Error('Migration 0004 did not preserve and read pre-existing fixture evidence')
    }

    const constraintRows = await migrationPool.query<{ conname: string }>(
      `SELECT conname
      FROM pg_constraint
      WHERE conrelid IN ('parse_tasks'::regclass, 'requirements'::regclass)
        AND conname = ANY($1::text[])`,
      [[
        'parse_tasks_type_check',
        'requirements_extraction_method_check',
        'requirements_confidence_ck',
        'requirements_evidence_kind_locator_v1_ck',
      ]],
    )
    if (constraintRows.rows.length !== 4) {
      throw new Error('Migration 0004 did not install every named task/evidence constraint')
    }

    const validRealTaskId = createId()
    await insertMigrationTask(migrationPool, {
      id: validRealTaskId,
      tenantId: migrationTenantId,
      projectId: migrationProjectId,
      fileId: migrationFileId,
      type: 'document-parse-v1',
      now: migrationNow,
    })
    const validClaimAt = new Date().toISOString()
    const validClaim = await migrationRepository.claimTask(
      migrationTenantId,
      validRealTaskId,
      'smoke-evidence-valid',
      validClaimAt,
      new Date(Date.parse(validClaimAt) + 60_000).toISOString(),
      3,
    )
    if (!validClaim) throw new Error('Migration evidence smoke could not claim a real task')
    const validRealRequirement = realTxtRequirement({
      tenantId: migrationTenantId,
      projectId: migrationProjectId,
      fileId: migrationFileId,
      fileName: migrationFileName,
      fileSha256: migrationFileSha256,
      taskId: validRealTaskId,
      now: validClaimAt,
    })
    const validCompletion = await migrationRepository.completeTask(
      validClaim.lease,
      [validRealRequirement],
      new Date().toISOString(),
    )
    if (validCompletion?.status !== 'succeeded') {
      throw new Error('Migration evidence smoke could not persist valid real evidence')
    }
    const withRealEvidence = await migrationRepository.listRequirements(
      migrationTenantId,
      migrationProjectId,
      {},
    )
    const persistedReal = withRealEvidence.find((candidate) => candidate.taskId === validRealTaskId)
    if (
      persistedReal?.extractionMethod !== 'deterministic-rules-v1' ||
      persistedReal.confidence !== 0.875 ||
      persistedReal.sourceLocator.kind !== 'txt'
    ) {
      throw new Error('Migration evidence smoke could not read valid real evidence')
    }

    const invalidRealTaskId = createId()
    await insertMigrationTask(migrationPool, {
      id: invalidRealTaskId,
      tenantId: migrationTenantId,
      projectId: migrationProjectId,
      fileId: migrationFileId,
      type: 'document-parse-v1',
      now: migrationNow,
    })
    const invalidRealClaimAt = new Date().toISOString()
    const invalidRealClaim = await migrationRepository.claimTask(
      migrationTenantId,
      invalidRealTaskId,
      'smoke-evidence-invalid-real',
      invalidRealClaimAt,
      new Date(Date.parse(invalidRealClaimAt) + 60_000).toISOString(),
      3,
    )
    if (!invalidRealClaim) throw new Error('Migration evidence smoke could not claim invalid real task')

    await expectRejected('fixture evidence for a real task', () =>
      migrationRepository.completeTask(
        invalidRealClaim.lease,
        [fixtureRequirement({
          tenantId: migrationTenantId,
          projectId: migrationProjectId,
          fileId: migrationFileId,
          fileName: migrationFileName,
          taskId: invalidRealTaskId,
          now: invalidRealClaimAt,
        })],
        new Date().toISOString(),
      ),
    )
    for (const confidence of [0.12345, 1.1]) {
      await expectRejected(`invalid real confidence ${confidence}`, () =>
        migrationRepository.completeTask(
          invalidRealClaim.lease,
          [realTxtRequirement({
            tenantId: migrationTenantId,
            projectId: migrationProjectId,
            fileId: migrationFileId,
            fileName: migrationFileName,
            fileSha256: migrationFileSha256,
            taskId: invalidRealTaskId,
            now: invalidRealClaimAt,
            confidence,
          })],
          new Date().toISOString(),
        ),
      )
    }

    const malformed = realTxtRequirement({
      tenantId: migrationTenantId,
      projectId: migrationProjectId,
      fileId: migrationFileId,
      fileName: migrationFileName,
      fileSha256: migrationFileSha256,
      taskId: invalidRealTaskId,
      now: invalidRealClaimAt,
    })
    malformed.sourceLocator = { kind: 'txt', version: 1 } as unknown as TxtSourceLocatorV1
    await expectRuntimeRejected('malformed real locator JSON', () =>
      migrationRepository.completeTask(
        invalidRealClaim.lease,
        [malformed],
        new Date().toISOString(),
      ),
    )

    const mismatchedMetadata = realTxtRequirement({
      tenantId: migrationTenantId,
      projectId: migrationProjectId,
      fileId: migrationFileId,
      fileName: migrationFileName,
      fileSha256: migrationFileSha256,
      taskId: invalidRealTaskId,
      now: invalidRealClaimAt,
    })
    mismatchedMetadata.sourceLocator = {
      ...mismatchedMetadata.sourceLocator,
      sourceSha256: 'b'.repeat(64),
    }
    await expectRejected('real evidence with mismatched locked-file metadata', () =>
      migrationRepository.completeTask(
        invalidRealClaim.lease,
        [mismatchedMetadata],
        new Date().toISOString(),
      ),
    )

    const invalidDevelopmentTaskId = createId()
    await insertMigrationTask(migrationPool, {
      id: invalidDevelopmentTaskId,
      tenantId: migrationTenantId,
      projectId: migrationProjectId,
      fileId: migrationFileId,
      type: 'development-document-parse',
      now: migrationNow,
    })
    const invalidDevelopmentClaimAt = new Date().toISOString()
    const invalidDevelopmentClaim = await migrationRepository.claimTask(
      migrationTenantId,
      invalidDevelopmentTaskId,
      'smoke-evidence-invalid-development',
      invalidDevelopmentClaimAt,
      new Date(Date.parse(invalidDevelopmentClaimAt) + 60_000).toISOString(),
      3,
    )
    if (!invalidDevelopmentClaim) {
      throw new Error('Migration evidence smoke could not claim invalid development task')
    }
    await expectRejected('real evidence for a development task', () =>
      migrationRepository.completeTask(
        invalidDevelopmentClaim.lease,
        [realTxtRequirement({
          tenantId: migrationTenantId,
          projectId: migrationProjectId,
          fileId: migrationFileId,
          fileName: migrationFileName,
          fileSha256: migrationFileSha256,
          taskId: invalidDevelopmentTaskId,
          now: invalidDevelopmentClaimAt,
        })],
        new Date().toISOString(),
      ),
    )

    await expectRejected('database evidence method/kind mismatch', () =>
      migrationPool!.query(
        `INSERT INTO requirements (
          id, tenant_id, project_id, file_id, task_id, code, title, description,
          category, priority, confirmation_status, confirmation_note, confirmed_at,
          extraction_method, confidence, source_locator, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'Invalid evidence','Invalid evidence',
          'technical','normal','pending',NULL,NULL,'development-fixture',NULL,$7::jsonb,$8,$8)`,
        [
          createId(),
          migrationTenantId,
          migrationProjectId,
          migrationFileId,
          invalidDevelopmentTaskId,
          `INVALID-${createId()}`,
          JSON.stringify({ kind: 'txt', version: 1 }),
          migrationNow,
        ],
      ),
    )
    await expectRejected('database out-of-bounds confidence', () =>
      migrationPool!.query(
        `INSERT INTO requirements (
          id, tenant_id, project_id, file_id, task_id, code, title, description,
          category, priority, confirmation_status, confirmation_note, confirmed_at,
          extraction_method, confidence, source_locator, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'Invalid confidence','Invalid confidence',
          'technical','normal','pending',NULL,NULL,'deterministic-rules-v1',1.1,$7::jsonb,$8,$8)`,
        [
          createId(),
          migrationTenantId,
          migrationProjectId,
          migrationFileId,
          invalidRealTaskId,
          `INVALID-${createId()}`,
          JSON.stringify(realTxtRequirement({
            tenantId: migrationTenantId,
            projectId: migrationProjectId,
            fileId: migrationFileId,
            fileName: migrationFileName,
            fileSha256: migrationFileSha256,
            taskId: invalidRealTaskId,
            now: migrationNow,
          }).sourceLocator),
          migrationNow,
        ],
      ),
    )
  } finally {
    if (migrationPool) await migrationPool.end().catch(() => undefined)
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`).catch(() => undefined)
  }
}

try {
  await runEvidenceMigrationSmoke(pool, databaseUrl)
  await objectStorage.ping()
  await repository.createProject({
    id: projectId,
    tenantId,
    name: 'PostgreSQL repository smoke test',
    code: null,
    customerName: null,
    ownerName: null,
    deadline: null,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  })
  const projects = await repository.listProjects(tenantId)
  if (projects.length !== 1 || projects[0]?.id !== projectId) {
    throw new Error('PostgreSQL repository smoke test could not read its project')
  }
  if (await repository.findProject('another-tenant', projectId)) {
    throw new Error('PostgreSQL repository leaked a project across tenant boundaries')
  }

  const fileId = createId()
  const taskId = createId()
  const content = Buffer.from('development smoke fixture')
  const file = {
    id: fileId,
    tenantId,
    projectId,
    fileName: 'smoke.txt',
    mediaType: 'text/plain',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    parseStatus: 'queued' as const,
    createdAt: now,
    updatedAt: now,
  }
  uploadedObject = await objectStorage.putObject({
    key: originalObjectKey(file),
    body: content,
    contentType: file.mediaType,
    sha256: file.sha256,
  })
  if (config.s3Endpoint && config.s3Bucket && config.s3ForcePathStyle) {
    const baseUrl = config.s3Endpoint.endsWith('/') ? config.s3Endpoint : `${config.s3Endpoint}/`
    const anonymousUrl = new URL(`${config.s3Bucket}/${uploadedObject.key}`, baseUrl)
    const anonymousResponse = await fetch(anonymousUrl)
    if (anonymousResponse.status !== 401 && anonymousResponse.status !== 403) {
      throw new Error(
        `S3 smoke test expected the object to reject anonymous reads, received ${anonymousResponse.status}`,
      )
    }
  }
  const upload: NewUpload = {
    file: {
      ...file,
      objectReference: uploadedObject,
    },
    task: {
      id: taskId,
      tenantId,
      projectId,
      fileId,
      type: 'development-document-parse',
      status: 'queued',
      progress: 0,
      attempt: 0,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    },
  }
  await repository.createUpload(upload)
  const storedMetadata = await pool.query<{
    content: Buffer | null
    object_key: string | null
  }>(
    'SELECT content, object_key FROM project_files WHERE tenant_id = $1 AND id = $2',
    [tenantId, fileId],
  )
  if (storedMetadata.rows[0]?.content !== null || storedMetadata.rows[0]?.object_key !== uploadedObject.key) {
    throw new Error('PostgreSQL repository did not persist an object-backed file without bytea content')
  }
  const relayNow = new Date(Date.parse(now) + 1_000).toISOString()
  const outboxEvents = await repository.claimOutboxEvents(
    'smoke-relay',
    relayNow,
    new Date(Date.parse(relayNow) + 10_000).toISOString(),
    10,
  )
  const uploadEvent = outboxEvents.find((event) => event.taskId === taskId)
  if (!uploadEvent) throw new Error('PostgreSQL repository did not create an upload outbox event')
  if (!await repository.markOutboxEventPublished(uploadEvent.id, 'smoke-relay', relayNow)) {
    throw new Error('PostgreSQL repository could not mark its upload outbox event as published')
  }

  const firstClaimAt = new Date(Date.parse(now) + 2_000).toISOString()
  const firstLeaseExpiry = new Date(Date.parse(firstClaimAt) + 100).toISOString()
  const firstClaim = await repository.claimTask(
    tenantId,
    taskId,
    'smoke-worker-a',
    firstClaimAt,
    firstLeaseExpiry,
    config.taskMaxAttempts,
  )
  if (!firstClaim || firstClaim.task.attempt !== 1) {
    throw new Error('PostgreSQL repository could not claim the queued task with its first lease')
  }
  const blockedClaim = await repository.claimTask(
    tenantId,
    taskId,
    'smoke-worker-b',
    new Date(Date.parse(firstClaimAt) + 50).toISOString(),
    new Date(Date.parse(firstClaimAt) + 5_000).toISOString(),
    config.taskMaxAttempts,
  )
  if (blockedClaim) throw new Error('PostgreSQL repository allowed a live task lease to be stolen')

  await delay(150)
  const forgedLiveTimestamp = new Date(Date.parse(firstClaimAt) + 50).toISOString()
  const expiredFailure = await repository.failTask(
    firstClaim.lease,
    { code: 'CLOCK_SKEW_PROBE', message: 'A stale caller timestamp must not extend a lease' },
    forgedLiveTimestamp,
    true,
  )
  if (expiredFailure) {
    throw new Error('PostgreSQL repository trusted a worker timestamp after the database lease expired')
  }

  const secondClaimAt = new Date().toISOString()
  const secondClaim = await repository.claimTask(
    tenantId,
    taskId,
    'smoke-worker-b',
    secondClaimAt,
    new Date(Date.parse(secondClaimAt) + 30_000).toISOString(),
    config.taskMaxAttempts,
  )
  if (!secondClaim || secondClaim.task.attempt !== 2) {
    throw new Error('PostgreSQL repository did not recover an expired task lease')
  }
  const fileContentLoader = new FileContentLoader(repository, objectStorage)
  const storedFile = await fileContentLoader.loadForProcessing(tenantId, fileId)
  if (!storedFile) throw new Error('PostgreSQL repository could not read its uploaded file')
  if (!storedFile.content.equals(content)) {
    throw new Error('PostgreSQL repository and S3 did not round-trip the uploaded bytes')
  }
  if (await fileContentLoader.loadForProcessing('another-tenant', fileId)) {
    throw new Error('PostgreSQL repository leaked an object-backed file across tenant boundaries')
  }

  const legacyFileId = createId()
  const legacyContent = Buffer.from('legacy bytea smoke fixture')
  await pool.query(
    `INSERT INTO project_files (
      id, tenant_id, project_id, file_name, media_type, size_bytes, sha256, content,
      parse_status, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      legacyFileId,
      tenantId,
      projectId,
      'legacy.txt',
      'text/plain',
      legacyContent.length,
      createHash('sha256').update(legacyContent).digest('hex'),
      legacyContent,
      'queued',
      now,
      now,
    ],
  )
  const legacyStoredFile = await fileContentLoader.loadForProcessing(tenantId, legacyFileId)
  if (!legacyStoredFile?.content.equals(legacyContent)) {
    throw new Error('PostgreSQL repository could not read a migration-era bytea file')
  }

  const retryRaceTaskId = createId()
  const retryRaceCreatedAt = new Date().toISOString()
  await pool.query(
    `INSERT INTO parse_tasks (
      id, tenant_id, project_id, file_id, type, status, progress, error,
      created_at, started_at, finished_at, updated_at
    ) VALUES ($1,$2,$3,$4,'development-document-parse','queued',0,NULL,$5,NULL,NULL,$5)`,
    [retryRaceTaskId, tenantId, projectId, legacyFileId, retryRaceCreatedAt],
  )
  const retryRaceClaimedAt = new Date()
  const retryRaceClaim = await repository.claimTask(
    tenantId,
    retryRaceTaskId,
    'smoke-retry-race-worker-a',
    retryRaceClaimedAt.toISOString(),
    new Date(retryRaceClaimedAt.getTime() + 50).toISOString(),
    3,
  )
  if (!retryRaceClaim) throw new Error('PostgreSQL retry race fixture could not claim its task')
  await delay(75)

  const requeueClient = await pool.connect()
  let requeueTransactionOpen = false
  try {
    await requeueClient.query('BEGIN')
    requeueTransactionOpen = true
    const requeued = await requeueClient.query(
      `UPDATE parse_tasks
      SET status = 'queued', progress = 0,
        error = jsonb_build_object('code', 'OBJECT_STORAGE_UNAVAILABLE', 'message', 'retry later'),
        started_at = NULL, finished_at = NULL, updated_at = clock_timestamp(),
        next_attempt_at = clock_timestamp() + interval '30 seconds',
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE tenant_id = $1 AND id = $2 AND lease_token = $3
      RETURNING id`,
      [tenantId, retryRaceTaskId, retryRaceClaim.lease.token],
    )
    if (requeued.rowCount !== 1) throw new Error('PostgreSQL retry race fixture could not requeue')

    const concurrentClaimedAt = new Date()
    const concurrentClaim = repository.claimTask(
      tenantId,
      retryRaceTaskId,
      'smoke-retry-race-worker-b',
      concurrentClaimedAt.toISOString(),
      new Date(concurrentClaimedAt.getTime() + 30_000).toISOString(),
      3,
    )
    await delay(50)
    await requeueClient.query(
      `INSERT INTO task_outbox (
        id, tenant_id, task_id, publish_attempts, available_at, created_at
      ) VALUES ($1,$2,$3,0,clock_timestamp() + interval '30 seconds',clock_timestamp())`,
      [createId(), tenantId, retryRaceTaskId],
    )
    await requeueClient.query('COMMIT')
    requeueTransactionOpen = false

    if (await concurrentClaim) {
      throw new Error('PostgreSQL claim bypassed retry backoff during a concurrent requeue')
    }
    const retryRaceTask = await repository.findTask(tenantId, retryRaceTaskId)
    if (retryRaceTask?.status !== 'queued' || retryRaceTask.attempt !== 1) {
      throw new Error('PostgreSQL retry race did not preserve the delayed queued task')
    }
  } catch (error) {
    if (requeueTransactionOpen) await requeueClient.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    requeueClient.release()
  }

  const crashTaskId = createId()
  const crashTaskCreatedAt = new Date().toISOString()
  await pool.query(
    `INSERT INTO parse_tasks (
      id, tenant_id, project_id, file_id, type, status, progress, error,
      created_at, started_at, finished_at, updated_at
    ) VALUES ($1,$2,$3,$4,'development-document-parse','queued',0,NULL,$5,NULL,NULL,$5)`,
    [crashTaskId, tenantId, projectId, legacyFileId, crashTaskCreatedAt],
  )
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimedAt = new Date()
    const crashClaim = await repository.claimTask(
      tenantId,
      crashTaskId,
      `smoke-crash-worker-${attempt}`,
      claimedAt.toISOString(),
      new Date(claimedAt.getTime() + 50).toISOString(),
      3,
    )
    if (crashClaim?.task.attempt !== attempt) {
      throw new Error(`PostgreSQL repository did not grant crash attempt ${attempt}`)
    }
    await delay(75)
  }
  const exhaustedAt = new Date()
  const exhaustedClaim = await repository.claimTask(
    tenantId,
    crashTaskId,
    'smoke-crash-worker-exhausted',
    exhaustedAt.toISOString(),
    new Date(exhaustedAt.getTime() + 50).toISOString(),
    3,
  )
  const exhaustedTask = await repository.findTask(tenantId, crashTaskId)
  if (
    exhaustedClaim !== null ||
    exhaustedTask?.status !== 'failed' ||
    exhaustedTask.attempt !== 3 ||
    exhaustedTask.error?.code !== 'TASK_ATTEMPTS_EXHAUSTED'
  ) {
    throw new Error('PostgreSQL repository did not dead-letter a repeatedly crashed task')
  }

  const requirements = await new DevelopmentDocumentParser().parse(
    storedFile,
    taskId,
    secondClaimAt,
  )
  const staleCompletion = await repository.completeTask(
    firstClaim.lease,
    requirements,
    new Date(Date.parse(secondClaimAt) + 1_000).toISOString(),
  )
  if (staleCompletion) throw new Error('PostgreSQL repository accepted a stale worker fencing token')
  const completed = await repository.completeTask(
    secondClaim.lease,
    requirements,
    new Date(Date.parse(secondClaimAt) + 2_000).toISOString(),
  )
  if (completed?.status !== 'succeeded') {
    throw new Error('PostgreSQL repository could not complete the task with its current lease')
  }
  const persistedRequirements = await repository.listRequirements(tenantId, projectId, {})
  if (persistedRequirements.length !== requirements.length) {
    throw new Error('PostgreSQL repository could not persist parsed requirements')
  }
  const requirement = persistedRequirements[0]
  if (!requirement) throw new Error('PostgreSQL repository did not return a requirement')
  const confirmed = await repository.confirmRequirement(tenantId, projectId, requirement.id, {
    status: 'confirmed',
    note: 'smoke test',
    confirmedAt: new Date().toISOString(),
  })
  if (confirmed?.confirmationStatus !== 'confirmed') {
    throw new Error('PostgreSQL repository could not confirm a requirement')
  }
  if ((await repository.listRequirements('another-tenant', projectId, {})).length !== 0) {
    throw new Error('PostgreSQL repository leaked requirements across tenant boundaries')
  }
} finally {
  await pool.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]).catch(() => undefined)
  if (uploadedObject) await objectStorage.deleteObject(uploadedObject).catch(() => undefined)
  await objectStorage.close().catch(() => undefined)
  await repository.close()
}
