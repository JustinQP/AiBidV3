import type { ParseTask, Requirement, StoredProjectFile } from '../domain/models.js'
import type { DevelopmentDocumentParser } from './development-document-parser.js'

export interface DocumentParser {
  parse(
    file: StoredProjectFile,
    task: ParseTask,
    now: string,
    signal: AbortSignal,
  ): Promise<Requirement[]>
}

export class DocumentParserRouter implements DocumentParser {
  constructor(
    private readonly developmentParser: DevelopmentDocumentParser,
    private readonly realParser: DocumentParser,
  ) {}

  async parse(
    file: StoredProjectFile,
    task: ParseTask,
    now: string,
    signal: AbortSignal,
  ): Promise<Requirement[]> {
    signal.throwIfAborted()
    switch (task.type) {
      case 'development-document-parse':
        return this.developmentParser.parse(file, task.id, now)
      case 'document-parse-v1':
        return this.realParser.parse(file, task, now, signal)
      default:
        throw new Error('Unsupported document parser task type')
    }
  }
}
