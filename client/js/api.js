// Request helper bound to the current connection.

import { NightcordError } from "./connection.js";
import { ERR } from "./protocol.js";
import { state } from "./state.js";
import { scopedT } from "./strings.js";

const t = scopedT("api");

export function req(type, payload) {
  if (!state.conn) return Promise.reject(new NightcordError(ERR.DISCONNECTED, t("not_connected")));
  return state.conn.request(type, payload);
}
