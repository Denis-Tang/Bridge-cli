/**
 * Base error for all orchestrator errors.
 */
export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export class ValidationError extends OrchestratorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class StateTransitionError extends OrchestratorError {
  constructor(from: string, to: string) {
    super(
      `Cannot transition from '${from}' to '${to}'`,
      'INVALID_STATE_TRANSITION',
      { from, to },
    );
    this.name = 'StateTransitionError';
  }
}

export class SchemaValidationError extends OrchestratorError {
  constructor(
    message: string,
    public readonly errors: Array<{ path: string; message: string }>,
  ) {
    super(message, 'SCHEMA_VALIDATION_ERROR', { errors });
    this.name = 'SchemaValidationError';
  }
}

export class FileNotFoundError extends OrchestratorError {
  constructor(path: string) {
    super(`File not found: ${path}`, 'FILE_NOT_FOUND', { path });
    this.name = 'FileNotFoundError';
  }
}
