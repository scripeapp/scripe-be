const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";
const IDLE_TRANSACTION_TIMEOUT = "25P03";
const QUERY_CANCELED = "57014";

export type DatabaseErrorKind =
  | "unique-violation"
  | "foreign-key-violation"
  | "check-violation"
  | "serialization-failure"
  | "deadlock"
  | "lock-timeout"
  | "statement-timeout"
  | "connection-unavailable"
  | "connection-acquire-timeout"
  | "unexpected";

export class DatabaseError extends Error {
  readonly kind: DatabaseErrorKind;
  readonly code?: string;
  readonly constraint?: string;
  readonly column?: string;
  readonly table?: string;
  readonly details?: string;

  constructor(
    kind: DatabaseErrorKind,
    message: string,
    fields: {
      code?: string;
      constraint?: string;
      column?: string;
      table?: string;
      details?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "DatabaseError";
    this.kind = kind;
    this.code = fields.code;
    this.constraint = fields.constraint;
    this.column = fields.column;
    this.table = fields.table;
    this.details = fields.details;
    if (fields.cause !== undefined) {
      this.cause = fields.cause;
    }
  }

  static isRetryable(kind: DatabaseErrorKind): boolean {
    return (
      kind === "serialization-failure" ||
      kind === "deadlock" ||
      kind === "lock-timeout"
    );
  }
}

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
  column?: string;
  table?: string;
  detail?: string;
  schema?: string;
  routine?: string;
}

export function normalizeDatabaseError(error: unknown): DatabaseError {
  const pgError = error as PostgresError;

  switch (pgError.code) {
    case UNIQUE_VIOLATION:
      return new DatabaseError("unique-violation", "A record with those unique values already exists.", pgError);
    case FOREIGN_KEY_VIOLATION:
      return new DatabaseError("foreign-key-violation", "The referenced record does not exist.", pgError);
    case CHECK_VIOLATION:
      return new DatabaseError("check-violation", "The value violates a database constraint.", pgError);
    case SERIALIZATION_FAILURE:
      return new DatabaseError("serialization-failure", "The transaction could not be serialized; retry it.", pgError);
    case DEADLOCK_DETECTED:
      return new DatabaseError("deadlock", "The transaction deadlocked with another transaction; retry it.", pgError);
    case IDLE_TRANSACTION_TIMEOUT:
      return new DatabaseError("lock-timeout", "The transaction exceeded the idle timeout.", pgError);
    case QUERY_CANCELED:
      return new DatabaseError("statement-timeout", "The statement exceeded the statement timeout.", pgError);
    default:
      return new DatabaseError(
        "unexpected",
        "An unexpected database error occurred.",
        { code: pgError.code, cause: error },
      );
  }
}

export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError;
}
