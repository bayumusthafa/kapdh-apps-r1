import { Inject, Injectable } from "@nestjs/common";
import { DB } from "../tokens.js";
import { withTx } from "./tx.js";
import type { Db, Tx } from "./types.js";

/** Versi injectable dari {@link withTx}: `await this.txRunner.run(async (tx) => …)`. */
@Injectable()
export class TxRunner {
  constructor(@Inject(DB) private readonly db: Db) {}

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTx(this.db, fn);
  }
}
