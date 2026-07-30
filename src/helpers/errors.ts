// ---------------------------------------------------------------------------------
// The two error types safeCall treats specially.  They live here, apart from the
// handlers, so models can throw them without importing ApiHandlers - which would
// make ServerModel and ApiHandlers import each other in a cycle.
// ---------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------
// UserError - throw a UserError if you want the error text to make it back to the user
// ---------------------------------------------------------------------------------
export class UserError {
  message: string;
  constructor(message: string) {
    this.message = message;
  }
}

// ---------------------------------------------------------------------------------
// AuthorizationError - throw an AuthorizationError for auth problems
// ---------------------------------------------------------------------------------
export class AuthorizationError {
  message: string;
  constructor(message: string) {
    this.message = message;
  }
}
