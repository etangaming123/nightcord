// Request helper bound to the current connection.

import { NightcordError } from "./connection.js";
import { ERR } from "./protocol.js";
import { state } from "./state.js";

export function req(type, payload) {
  if (!state.conn) return Promise.reject(new NightcordError(ERR.DISCONNECTED, "Not connected"));
  return state.conn.request(type, payload);
}
