// The connection state machine and its error mapping live in the shared core
// now, so desktop and the iOS client say the same thing about a failure from the
// same source of truth (core/spec/connection.json). This is a thin re-export so
// nothing in desktop has to know where it moved.
export {
  hint, reason, failureNotice, status, isRealFailure, shouldMarkConnected, nextPhase,
  mayPresentGatewayView,
  HINTS, ERR_ABORTED, IDLE, CONNECTING, CONNECTED, FAILED, PENDING, PENDING_COPY,
} from '../../core/connection.js';
