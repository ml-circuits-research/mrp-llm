import {AsyncLocalStorage} from 'node:async_hooks';

// Request-local callbacks: existing formalizer wrappers need not expose runtime authority to the model.
export const authorExecution = new AsyncLocalStorage();
